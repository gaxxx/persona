#!/usr/bin/env bun
/**
 * daemon-stats.ts — snapshot of tg-daemon + cron-daemon health and context size.
 *
 * Run manually: `bun run bin/daemon-stats.ts`
 * Also dispatched by tg-daemon when user texts `/stats` (short-circuits
 * before reaching the inner claude — saves an LLM turn).
 *
 * Output is plain text, ~10 lines, fits Telegram comfortably.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { loadRegistry } from "./lib/session-registry";

const HOME = process.env.HOME ?? "";
const REPO_ROOT = resolve(import.meta.dir, "..");
const PROJECTS_DIR = resolve(
  HOME,
  ".claude-loop/projects",
  REPO_ROOT.replaceAll("/", "-"),
);
const CRON_LOG = resolve(import.meta.dir, "../data/cron.log");
const TG_STDERR = "/tmp/tg-daemon-stderr.log";
const TG_MAX_TURNS = 25;
const TG_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const TG_MAX_CACHE_READ = 500_000;
const TG_MIN_TURNS_FOR_CACHE_ROTATION = 5;

interface UsageRow {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

function pgrep(pattern: string): number | null {
  const r = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
  const lines = r.stdout.trim().split("\n").filter(Boolean);
  for (const l of lines) {
    const pid = parseInt(l, 10);
    if (Number.isFinite(pid) && pid !== process.pid) return pid;
  }
  return null;
}

function pidEtimeSec(pid: number): number | null {
  const r = spawnSync("ps", ["-p", String(pid), "-o", "etime="], {
    encoding: "utf8",
  });
  const s = r.stdout.trim();
  if (!s) return null;
  // formats: "MM:SS", "HH:MM:SS", "DD-HH:MM:SS"
  const m = s.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, d, h, mi, se] = m;
  return (
    (d ? parseInt(d, 10) * 86400 : 0) +
    (h ? parseInt(h, 10) * 3600 : 0) +
    parseInt(mi, 10) * 60 +
    parseInt(se, 10)
  );
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}h${m}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function findActiveSession(): string | null {
  // tg-daemon writes its inner claude's session_id to stderr; parse the most
  // recent one. mtime alone is unreliable because cron-spawned claude sessions
  // and the user's own REPL session also write to PROJECTS_DIR.
  if (!existsSync(TG_STDERR)) return null;
  const tail = readFileSync(TG_STDERR, "utf8").split("\n");
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(/"session_id":"([^"]+)"/);
    if (m) {
      const p = resolve(PROJECTS_DIR, `${m[1]}.jsonl`);
      return existsSync(p) ? p : null;
    }
  }
  return null;
}

interface SessionStats {
  sessionId: string;
  turns: number;
  lastUsage: UsageRow | null;
  contextTokens: number;
  totals: UsageRow;
}

/**
 * Find the most recently modified .jsonl in PROJECTS_DIR — used as a fallback
 * when tg-daemon isn't running but `/loop /assistant-loop` is. The loop's
 * active session is the most recently written one.
 */
function findLatestSession(): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(PROJECTS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const p = resolve(PROJECTS_DIR, name);
    try {
      const st = statSync(p);
      if (!best || st.mtimeMs > best.mtime) best = { path: p, mtime: st.mtimeMs };
    } catch {
      // skip
    }
  }
  return best?.path ?? null;
}

function readSessionStats(file: string): SessionStats {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let lastUsage: UsageRow | null = null;
  let userTurns = 0;
  const totals: UsageRow = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  let sessionId: string | null = null;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        operation?: string;
        usage?: UsageRow;
        session_id?: string;
        sessionId?: string;
        message?: { role?: string; usage?: UsageRow };
      };
      sessionId ??= obj.session_id ?? obj.sessionId ?? null;

      // tg-daemon stream-json: usage lives at top level on type=result rows.
      if (obj.type === "result" && obj.usage) {
        lastUsage = obj.usage;
        userTurns++;
        addUsage(totals, obj.usage);
        continue;
      }

      // assistant-loop session: usage lives inside message.usage on assistant
      // rows; one user prompt produces N assistant rows (tool calls etc.) so
      // we count user turns separately via queue-operation enqueue events.
      if (obj.type === "assistant" && obj.message?.usage) {
        lastUsage = obj.message.usage;
        addUsage(totals, obj.message.usage);
      }
      if (obj.type === "queue-operation" && obj.operation === "enqueue") {
        userTurns++;
      }
    } catch {
      // skip malformed lines
    }
  }
  const u = lastUsage;
  const ctx = u
    ? (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    : 0;
  return {
    sessionId: sessionId ?? file.split("/").pop()!.replace(".jsonl", ""),
    turns: userTurns,
    lastUsage: u,
    contextTokens: ctx,
    totals,
  };
}

function addUsage(dst: UsageRow, src: UsageRow): void {
  dst.input_tokens = (dst.input_tokens ?? 0) + (src.input_tokens ?? 0);
  dst.cache_creation_input_tokens =
    (dst.cache_creation_input_tokens ?? 0) +
    (src.cache_creation_input_tokens ?? 0);
  dst.cache_read_input_tokens =
    (dst.cache_read_input_tokens ?? 0) + (src.cache_read_input_tokens ?? 0);
  dst.output_tokens = (dst.output_tokens ?? 0) + (src.output_tokens ?? 0);
}

function usageLines(prefix: string, s: SessionStats): string[] {
  const lines: string[] = [];
  if (s.lastUsage) {
    const u = s.lastUsage;
    const t = s.totals;
    lines.push(
      `${prefix}last turn: in=${fmtTokens(u.input_tokens ?? 0)} cache_cr=${fmtTokens(u.cache_creation_input_tokens ?? 0)} cache_rd=${fmtTokens(u.cache_read_input_tokens ?? 0)} out=${fmtTokens(u.output_tokens ?? 0)}`,
      `${prefix}session totals: cache_cr=${fmtTokens(t.cache_creation_input_tokens ?? 0)} cache_rd=${fmtTokens(t.cache_read_input_tokens ?? 0)} out=${fmtTokens(t.output_tokens ?? 0)}`,
      `${prefix}context: ~${fmtTokens(s.contextTokens)} tokens`,
    );
  } else {
    lines.push(`${prefix}no completed turns yet`);
  }
  return lines;
}

function tgDaemonReport(): string {
  const pid = pgrep("bun.*tg-daemon\\.ts");
  if (!pid) {
    // Fall back to assistant-loop session when tg-daemon isn't the active TG
    // handler. The user runs either tg-daemon OR `/loop /assistant-loop`,
    // never both — the latter writes to PROJECTS_DIR too, so we can still
    // show useful token stats.
    const session = findLatestSession();
    if (!session) return "tg-daemon: ❌ DOWN (no fallback session)";
    const st = statSync(session);
    const ageSec = Math.floor((Date.now() - st.mtimeMs) / 1000);
    if (ageSec > 30 * 60) {
      return `tg-daemon: ❌ DOWN (last session ${fmtDuration(ageSec)} stale)`;
    }
    const s = readSessionStats(session);
    const lines = [
      `loop: ✓ session ${s.sessionId.slice(0, 8)}… (assistant-loop, last write ${fmtDuration(ageSec)} ago)`,
      `  user turns: ${s.turns}`,
      ...usageLines("  ", s),
    ];
    return lines.join("\n");
  }
  const ageSec = pidEtimeSec(pid) ?? 0;
  const session = findActiveSession();
  if (!session) {
    return `tg-daemon: ✓ PID ${pid}, age ${fmtDuration(ageSec)} — no session yet`;
  }
  const s = readSessionStats(session);
  const ageMs = ageSec * 1000;
  const turnsLeft = Math.max(0, TG_MAX_TURNS - s.turns);
  const ageLeftMs = Math.max(0, TG_MAX_AGE_MS - ageMs);
  const lines = [
    `tg-daemon: ✓ PID ${pid}, age ${fmtDuration(ageSec)}, turns ${s.turns}/${TG_MAX_TURNS}`,
    `  session: ${s.sessionId.slice(0, 8)}…`,
    ...usageLines("  ", s),
  ];
  const cacheRead = s.lastUsage?.cache_read_input_tokens ?? 0;
  if (
    s.lastUsage &&
    cacheRead > TG_MAX_CACHE_READ &&
    s.turns >= TG_MIN_TURNS_FOR_CACHE_ROTATION
  ) {
    lines.push(`  ⚠️ cache_rd over budget — will rotate on next event`);
  }
  lines.push(
    `  rotates in: ${fmtDuration(Math.floor(ageLeftMs / 1000))} or ${turnsLeft} turns (or when cache_rd > ${fmtTokens(TG_MAX_CACHE_READ)})`,
  );
  return lines.join("\n");
}

function cronDaemonReport(): string {
  const pid = pgrep("bun.*cron-daemon\\.ts");
  if (!pid) return "cron-daemon: ❌ DOWN";
  const ageSec = pidEtimeSec(pid) ?? 0;
  let recent: string[] = [];
  if (existsSync(CRON_LOG)) {
    const all = readFileSync(CRON_LOG, "utf8").split("\n").filter(Boolean);
    const fires = all.filter((l) => / done /.test(l)).slice(-5);
    recent = fires.map((l) => {
      const m = l.match(/done (\S+) exit=(\d+) in (\S+)/);
      return m ? `${m[2] === "0" ? "✓" : "✗"} ${m[1]} (${m[3]})` : l;
    });
  }
  const lines = [`cron-daemon: ✓ PID ${pid}, age ${fmtDuration(ageSec)}`];
  if (recent.length) {
    lines.push(`  last 5 fires:`);
    for (const r of recent) lines.push(`    ${r}`);
  }
  return lines.join("\n");
}

// Opus 4.7 pricing per 1M tokens (USD). Update if rates change.
const PRICE_INPUT = 15;
const PRICE_OUTPUT = 75;
const PRICE_CACHE_WRITE = 18.75;
const PRICE_CACHE_READ = 1.5;

function estimateCost(u: UsageRow): number {
  const inp = (u.input_tokens ?? 0) * PRICE_INPUT;
  const out = (u.output_tokens ?? 0) * PRICE_OUTPUT;
  const cw = (u.cache_creation_input_tokens ?? 0) * PRICE_CACHE_WRITE;
  const cr = (u.cache_read_input_tokens ?? 0) * PRICE_CACHE_READ;
  return (inp + out + cw + cr) / 1_000_000;
}

type Bucket = "tg" | "loop" | "loop+tg" | "gmail" | "cron-other" | "other";

// Classify a session: registry first (authoritative for sessions started
// after the registry was wired up), then fall back to first-message heuristic
// for older sessions that pre-date the registry.
function classifySession(file: string, sessionId: string): Bucket {
  const reg = loadRegistry().get(sessionId);
  if (reg) {
    if (reg.role === "tg") return "tg";
    if (reg.role === "loop") return "loop";
    if (reg.role === "cron") return "cron-other";
  }
  const lines = readFileSync(file, "utf8").split("\n", 5).filter(Boolean);
  for (const line of lines) {
    let obj: { content?: unknown; message?: { content?: unknown } };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const raw =
      typeof obj.content === "string"
        ? obj.content
        : typeof obj.message?.content === "string"
          ? (obj.message.content as string)
          : "";
    if (!raw) continue;
    if (
      raw.includes("bin/gmail-digest.ts") ||
      raw.includes("mcp__gmail__batch_modify_emails")
    ) {
      return "gmail";
    }
    if (
      raw.includes("bin/daily-journal.ts") ||
      raw.startsWith("Morning brief (scheduled") ||
      raw.includes("non-interactive helper")
    ) {
      return "cron-other";
    }
    if (raw.includes("personal assistant running inside a long-lived daemon")) {
      return "loop+tg";
    }
  }
  return "other";
}

function billingReport(): string {
  if (!existsSync(PROJECTS_DIR)) return "billing: no projects dir";
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();

  const buckets: Record<Bucket, { today: UsageRow; all: UsageRow; nToday: number; nAll: number }> = {
    tg: { today: {}, all: {}, nToday: 0, nAll: 0 },
    loop: { today: {}, all: {}, nToday: 0, nAll: 0 },
    "loop+tg": { today: {}, all: {}, nToday: 0, nAll: 0 },
    gmail: { today: {}, all: {}, nToday: 0, nAll: 0 },
    "cron-other": { today: {}, all: {}, nToday: 0, nAll: 0 },
    other: { today: {}, all: {}, nToday: 0, nAll: 0 },
  };
  const total = { today: {} as UsageRow, all: {} as UsageRow, nToday: 0, nAll: 0 };

  for (const name of readdirSync(PROJECTS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const p = resolve(PROJECTS_DIR, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    const s = readSessionStats(p);
    const cat = classifySession(p, s.sessionId);
    addUsage(buckets[cat].all, s.totals);
    buckets[cat].nAll++;
    addUsage(total.all, s.totals);
    total.nAll++;
    if (st.mtimeMs >= todayMs) {
      addUsage(buckets[cat].today, s.totals);
      buckets[cat].nToday++;
      addUsage(total.today, s.totals);
      total.nToday++;
    }
  }

  const fmtRow = (label: string, n: number, u: UsageRow) =>
    `    ${label} (${n}): cache_cr=${fmtTokens(u.cache_creation_input_tokens ?? 0)} cache_rd=${fmtTokens(u.cache_read_input_tokens ?? 0)} out=${fmtTokens(u.output_tokens ?? 0)} ≈ $${estimateCost(u).toFixed(2)}`;

  const order: Bucket[] = ["tg", "loop", "loop+tg", "gmail", "cron-other", "other"];
  const lines = ["billing: PROJECTS_DIR aggregate (Opus 4.7 list price)"];

  lines.push(`  today (${total.nToday} sess, ≈ $${estimateCost(total.today).toFixed(2)}):`);
  for (const k of order) {
    if (buckets[k].nToday === 0) continue;
    lines.push(fmtRow(k, buckets[k].nToday, buckets[k].today));
  }
  lines.push(`  all-time (${total.nAll} sess, ≈ $${estimateCost(total.all).toFixed(2)}):`);
  for (const k of order) {
    if (buckets[k].nAll === 0) continue;
    lines.push(fmtRow(k, buckets[k].nAll, buckets[k].all));
  }
  return lines.join("\n");
}

function main(): void {
  console.log(tgDaemonReport());
  console.log("");
  console.log(cronDaemonReport());
  console.log("");
  console.log(billingReport());
}

main();
