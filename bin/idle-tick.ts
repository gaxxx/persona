#!/usr/bin/env bun
/**
 * idle-tick.ts — pure-Bun daemon watchdog. No LLM in the healthy path.
 *
 * Replaces the /loop /assistant-loop heartbeat. Each fire:
 *   1. pgrep tg-daemon + cron-daemon.
 *   2. If either is dead, restart it and tg-alert.
 *   3. After ESCALATE_AFTER consecutive restart failures (and ESCALATE_COOLDOWN_MS
 *      since the last escalation), spawn `claude -p` once with diagnostic
 *      context to investigate. Cooldown prevents spamming claude on every tick.
 *   4. Print one-line summary to stdout (cron-daemon stamps it as Last run).
 *
 * State persists in data/idle-tick-state.json across fires.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { resolve, dirname } from "path";
import { tgSend, defaultChatId } from "./lib/cron-helpers";

const ROOT = resolve(import.meta.dir, "..");
const CHAT_ID = defaultChatId();
const TG_LOG = "/tmp/tg-daemon-stderr.log";
const CRON_LOG = "/tmp/cron-daemon-stderr.log";
const STATE_FILE = resolve(ROOT, "data/idle-tick-state.json");

// Escalation policy: after this many consecutive restart failures for the same
// daemon, fire one diagnostic `claude -p`. Then wait cooldown before next.
const ESCALATE_AFTER = 3;
const ESCALATE_COOLDOWN_MS = 60 * 60 * 1000; // 1h

interface DaemonState {
  consecutive_failures: number;
  last_escalated_at?: string; // ISO
}
type State = Record<"tg-daemon" | "cron-daemon", DaemonState>;

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {
      "tg-daemon": { consecutive_failures: 0 },
      "cron-daemon": { consecutive_failures: 0 },
    };
  }
}

function saveState(s: State): void {
  if (!existsSync(dirname(STATE_FILE))) mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function isAlive(name: "tg-daemon" | "cron-daemon"): Promise<boolean> {
  // pgrep -f matches the full command line — too permissive; a shell whose
  // argv happens to contain "bin/<name>.ts" (e.g. someone running
  // `mv bin/<name>.ts ...`) would falsely match. Filter to only count
  // processes actually launched as `bun run bin/<name>.ts`.
  const proc = Bun.spawn(
    ["pgrep", "-af", `bun run bin/${name}\\.ts`],
    { stdout: "pipe", stderr: "ignore" },
  );
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  const exact = new RegExp(`^\\d+\\s+bun\\s+run\\s+bin/${name}\\.ts(\\s|$)`);
  return out.trim().split("\n").some((line) => exact.test(line));
}

function startDaemon(name: "tg-daemon" | "cron-daemon"): void {
  const logFile = name === "tg-daemon" ? TG_LOG : CRON_LOG;
  if (!existsSync(dirname(logFile))) mkdirSync(dirname(logFile), { recursive: true });
  // nohup + disown via shell so the proc survives this script's exit.
  Bun.spawn(
    ["sh", "-c", `nohup bun run bin/${name}.ts > ${logFile} 2>&1 &`],
    { cwd: ROOT, stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
}

async function waitFor(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function logContains(file: string, needle: string): Promise<boolean> {
  try {
    const text = await Bun.file(file).text();
    return text.includes(needle);
  } catch {
    return false;
  }
}

async function logTail(file: string, lines = 50): Promise<string> {
  try {
    const text = await Bun.file(file).text();
    return text.split("\n").slice(-lines).join("\n");
  } catch {
    return "(log unreadable)";
  }
}

async function shellOut(cmd: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd: ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  await proc.exited;
  const out = await new Response(proc.stdout).text();
  return out.trim();
}

async function escalateToClaude(name: "tg-daemon" | "cron-daemon"): Promise<void> {
  const stderrTail = await logTail(name === "tg-daemon" ? TG_LOG : CRON_LOG, 80);
  const recentCommits = await shellOut("git log --oneline -10");
  const fileInfo = await shellOut(`ls -la bin/${name}.ts bin/lib/ 2>&1`);
  const gitStatus = await shellOut("git status --short");

  const prompt = `${name} has failed to start ${ESCALATE_AFTER} times in a row. The pure-Bun watchdog (bin/idle-tick.ts) has already restarted the daemon and confirmed it never reached its ready marker. Investigate, fix if possible, and tg-send a status update to chat_id ${CHAT_ID}.

Diagnostic context:

== Recent stderr (last 80 lines of ${name === "tg-daemon" ? TG_LOG : CRON_LOG}) ==
${stderrTail}

== Recent commits ==
${recentCommits}

== File info ==
${fileInfo}

== git status ==
${gitStatus || "(clean)"}

Steps:
1. Read the stderr tail above to identify the root cause (missing module, perms, port conflict, syntax error, etc.).
2. If it's a quick fix (perms, missing dep, obvious bug) — fix it, then try \`bun run bin/${name}.ts\` once to verify (kill it after a few seconds with the readyMarker check, don't leave it running — the next idle-tick fire will spawn a real one).
3. If you can't fix it auto, tg-send a clear summary of the root cause to chat_id ${CHAT_ID} so Jade knows what's broken.
4. Do NOT modify CRON.md. Do NOT touch the data/ directory. Stay focused on the daemon.

Output a one-line summary as your final stdout line. Keep it short.`;

  // Detached spawn — claude can take 30-120s, we don't block this idle-tick fire.
  // Stdout to a per-invocation log for debugging.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const escalationLogDir = resolve(ROOT, "data/idle-tick-escalations");
  if (!existsSync(escalationLogDir)) mkdirSync(escalationLogDir, { recursive: true });
  const logPath = resolve(escalationLogDir, `${name}-${ts}.log`);

  const childEnv = { ...process.env };
  for (const k of Object.keys(childEnv)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
  }
  Bun.spawn(
    ["claude", "-p", prompt, "--permission-mode", "bypassPermissions"],
    {
      cwd: ROOT,
      env: childEnv,
      stdout: Bun.file(logPath),
      stderr: Bun.file(logPath + ".stderr"),
      stdin: "ignore",
    },
  );
  // Return immediately — claude runs detached.
}

interface DaemonCheck {
  name: "tg-daemon" | "cron-daemon";
  alertEmoji: string;
  readyMarker: string;
  primingTimeoutMs: number;
}

const DAEMONS: DaemonCheck[] = [
  { name: "tg-daemon", alertEmoji: "🦌", readyMarker: "priming complete", primingTimeoutMs: 60_000 },
  { name: "cron-daemon", alertEmoji: "⏰", readyMarker: "loaded ", primingTimeoutMs: 15_000 },
];

async function main(): Promise<void> {
  const events: string[] = [];
  const state = loadState();

  for (const d of DAEMONS) {
    if (await isAlive(d.name)) {
      // Healthy: reset failure counter for this daemon.
      if (state[d.name].consecutive_failures > 0) {
        state[d.name].consecutive_failures = 0;
      }
      continue;
    }

    // Truncate the log so readyMarker check sees only the new run's output.
    const logFile = d.name === "tg-daemon" ? TG_LOG : CRON_LOG;
    try { await Bun.write(logFile, ""); } catch {}

    startDaemon(d.name);
    const ok = await waitFor(() => logContains(logFile, d.readyMarker), d.primingTimeoutMs);
    if (ok) {
      state[d.name].consecutive_failures = 0;
      events.push(`${d.alertEmoji} ${d.name} was down, restarted`);
      try {
        await tgSend(CHAT_ID, `${d.alertEmoji} ${d.name} was down, restarted`);
      } catch (err) {
        events.push(`(tg-send failed: ${(err as Error).message})`);
      }
    } else {
      state[d.name].consecutive_failures++;
      const fails = state[d.name].consecutive_failures;
      const lastEsc = state[d.name].last_escalated_at;
      const cooldownActive = lastEsc && (Date.now() - new Date(lastEsc).getTime()) < ESCALATE_COOLDOWN_MS;

      const tail = (await logTail(logFile, 5));
      const baseMsg = `⚠️ ${d.name} failed to restart (${fails}x), manual intervention\n${tail}`;
      events.push(`⚠️ ${d.name} failed to restart (${fails}x)`);
      try { await tgSend(CHAT_ID, baseMsg); } catch {}

      if (fails >= ESCALATE_AFTER && !cooldownActive) {
        state[d.name].last_escalated_at = new Date().toISOString();
        events.push(`🤖 escalating ${d.name} to claude (${fails} consecutive failures)`);
        try {
          await tgSend(CHAT_ID, `🤖 ${d.name} failed ${fails}x — invoking claude to investigate (background, may take 1-2 min)`);
        } catch {}
        await escalateToClaude(d.name);
      }
    }
  }

  saveState(state);

  // Final stdout line — cron-daemon writes it into CRON.md's Last run.
  console.log(events.length === 0 ? "ok — both daemons alive" : events.join(" | "));
}

await main();
