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
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";

const HOME = process.env.HOME ?? "";
const PROJECTS_DIR = resolve(
  HOME,
  ".claude-loop/projects/-Users-woosiyun-playground-persona",
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
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
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
}

function readSessionStats(file: string): SessionStats {
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  let lastResult: { usage?: UsageRow; session_id?: string } | null = null;
  let turns = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        usage?: UsageRow;
        session_id?: string;
      };
      if (obj.type === "result") {
        lastResult = obj;
        turns++;
      }
    } catch {
      // skip malformed lines
    }
  }
  const u = lastResult?.usage ?? null;
  const ctx = u
    ? (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    : 0;
  return {
    sessionId: lastResult?.session_id ?? file.split("/").pop()!.replace(".jsonl", ""),
    turns,
    lastUsage: u,
    contextTokens: ctx,
  };
}

function tgDaemonReport(): string {
  const pid = pgrep("bun.*tg-daemon\\.ts");
  if (!pid) return "tg-daemon: ❌ DOWN";
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
  ];
  if (s.lastUsage) {
    const u = s.lastUsage;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    lines.push(
      `  last turn: in=${fmtTokens(u.input_tokens ?? 0)} cache_cr=${fmtTokens(u.cache_creation_input_tokens ?? 0)} cache_rd=${fmtTokens(cacheRead)} out=${fmtTokens(u.output_tokens ?? 0)}`,
      `  context: ~${fmtTokens(s.contextTokens)} tokens (cache_rd budget ${fmtTokens(cacheRead)}/${fmtTokens(TG_MAX_CACHE_READ)})`,
    );
    if (
      cacheRead > TG_MAX_CACHE_READ &&
      s.turns >= TG_MIN_TURNS_FOR_CACHE_ROTATION
    ) {
      lines.push(`  ⚠️ cache_rd over budget — will rotate on next event`);
    }
  } else {
    lines.push(`  context: ~0 tokens (no completed turns yet)`);
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

function main(): void {
  console.log(tgDaemonReport());
  console.log("");
  console.log(cronDaemonReport());
}

main();
