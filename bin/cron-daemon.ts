#!/usr/bin/env bun
/**
 * Cron daemon: parses CRON.md, schedules each task by its cron expression,
 * and on fire spawns a one-shot `claude -p --permission-mode bypassPermissions`
 * subprocess to handle it. Decoupled from main REPL and tg-daemon.
 *
 * - CRON.md is the source of truth; auto-reloads on change (fs.watch).
 * - Each fire is a fresh `claude -p` session (reads CLAUDE.md + skills, runs
 *   the prompt, exits).
 * - System timezone is used for cron evaluation (assumed to match the comments
 *   in CRON.md, e.g. "ET").
 *
 * Run: bun run bin/cron-daemon.ts
 */
import { existsSync, mkdirSync, readFileSync, watch, appendFileSync } from "fs";
import { resolve, dirname } from "path";

const ROOT = resolve(import.meta.dir, "..");
const VAULT = process.env.VAULT_PATH;
if (!VAULT) {
  console.error("VAULT_PATH is required (set it in .env)");
  process.exit(1);
}
const CRON_FILE = resolve(VAULT, "persona/CRON.md");
const LOG_FILE = resolve(ROOT, "data/cron.log");

if (!existsSync(dirname(LOG_FILE))) mkdirSync(dirname(LOG_FILE), { recursive: true });

function log(...parts: unknown[]) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;
  appendFileSync(LOG_FILE, line);
  process.stdout.write(line);
}

// ---- CRON.md parser -------------------------------------------------------

interface Task {
  id: string;
  cron: string;
  prompt: string;
}

function parseTaskMd(content: string): Task[] {
  const tasks: Task[] = [];
  // Sections start at "## <id>" (skip the top-level "How to register" section)
  const sections = content.split(/^## /m).slice(1);
  for (const sec of sections) {
    const lines = sec.split("\n");
    const id = lines[0].trim();
    if (!id || id.startsWith("How to register")) continue;
    const body = lines.slice(1).join("\n");
    const cronMatch = body.match(/^- \*\*Cron:\*\*\s*`([^`]+)`/m);
    if (!cronMatch) continue;
    // Prompt block: from "**Prompt:**" through the next "---" or EOF, take fenced code
    const promptIdx = body.search(/^- \*\*Prompt:\*\*/m);
    if (promptIdx < 0) continue;
    const after = body.slice(promptIdx);
    const fenceMatch = after.match(/```\s*\n([\s\S]*?)\n\s*```/);
    if (!fenceMatch) continue;
    const prompt = fenceMatch[1].trim();
    tasks.push({ id, cron: cronMatch[1].trim(), prompt });
  }
  return tasks;
}

// ---- Cron expression eval -------------------------------------------------
// Supports: */N, N,M,L (lists), N-M (ranges), * (any), single values.
// 5 fields: minute hour day-of-month month day-of-week. No seconds.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number> | null; // null = any
  month: Set<number>;
  dow: Set<number> | null; // null = any
}

function expandField(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const piece of spec.split(",")) {
    if (piece === "*") {
      for (let i = min; i <= max; i++) out.add(i);
    } else if (piece.startsWith("*/")) {
      const step = parseInt(piece.slice(2), 10);
      for (let i = min; i <= max; i += step) out.add(i);
    } else if (piece.includes("-")) {
      const [a, b] = piece.split("-").map((x) => parseInt(x, 10));
      for (let i = a; i <= b; i++) out.add(i);
    } else {
      out.add(parseInt(piece, 10));
    }
  }
  return out;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`expected 5 fields, got ${parts.length}: ${expr}`);
  const [m, h, dom, mon, dow] = parts;
  return {
    minute: expandField(m, 0, 59),
    hour: expandField(h, 0, 23),
    dom: dom === "*" ? null : expandField(dom, 1, 31),
    month: expandField(mon, 1, 12),
    dow: dow === "*" ? null : expandField(dow, 0, 6),
  };
}

function nextFire(fields: CronFields, from: Date): Date {
  // Walk forward minute-by-minute; cap at 366 days to avoid infinite loops on misconfigured fields.
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 366; i++) {
    if (
      fields.minute.has(d.getMinutes()) &&
      fields.hour.has(d.getHours()) &&
      (fields.dom === null || fields.dom.has(d.getDate())) &&
      fields.month.has(d.getMonth() + 1) &&
      (fields.dow === null || fields.dow.has(d.getDay()))
    ) {
      return d;
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error("no fire within 1 year - cron expression unreachable?");
}

// ---- Scheduling -----------------------------------------------------------

interface Scheduled {
  task: Task;
  fields: CronFields;
  timer?: Timer;
  nextAt?: Date;
  running?: boolean;
}

const scheduled: Map<string, Scheduled> = new Map();

function scheduleNext(s: Scheduled) {
  const now = new Date();
  const next = nextFire(s.fields, now);
  const ms = Math.max(1000, next.getTime() - now.getTime());
  s.nextAt = next;
  s.timer = setTimeout(() => fireTask(s), ms);
  log(`scheduled ${s.task.id} -> ${next.toISOString()} (in ${Math.round(ms / 1000)}s)`);
}

const RUN_LOG_DIR = resolve(ROOT, "data/cron-runs");

async function fireTask(s: Scheduled) {
  s.timer = undefined;
  if (s.running) {
    log(`skip ${s.task.id}: previous fire still running`);
    scheduleNext(s);
    return;
  }
  s.running = true;
  log(`fire ${s.task.id}`);
  const start = Date.now();

  // Per-fire log files so subprocess output is recoverable for debugging.
  if (!existsSync(RUN_LOG_DIR)) mkdirSync(RUN_LOG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stdoutPath = resolve(RUN_LOG_DIR, `${s.task.id}-${ts}.stdout.log`);
  const stderrPath = resolve(RUN_LOG_DIR, `${s.task.id}-${ts}.stderr.log`);

  try {
    // Strip Claude Code session vars so the spawned `claude -p` doesn't
    // refuse to start as a nested session.
    const childEnv = { ...process.env };
    for (const k of Object.keys(childEnv)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete childEnv[k];
    }
    const proc = Bun.spawn(
      [
        "claude",
        "-p",
        s.task.prompt,
        "--permission-mode",
        "bypassPermissions",
      ],
      {
        cwd: ROOT,
        env: childEnv,
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
        stdin: "ignore",
      },
    );
    const [exitCode] = await Promise.all([proc.exited]);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    // Tail of stdout (last ~400 chars) into cron.log for quick scanning.
    let tail = "";
    try {
      const text = await Bun.file(stdoutPath).text();
      tail = text.trim().slice(-400);
    } catch {}
    log(
      `done ${s.task.id} exit=${exitCode} in ${elapsed}s` +
        ` -- log:${stdoutPath}` +
        (tail ? `\n  tail: ${tail.replace(/\n/g, "\n        ")}` : "")
    );
  } catch (err) {
    log(`ERROR ${s.task.id}: ${(err as Error).message}`);
  } finally {
    s.running = false;
    scheduleNext(s);
  }
}

// ---- Load + reload --------------------------------------------------------

function loadAndSchedule() {
  let tasks: Task[];
  try {
    const content = readFileSync(CRON_FILE, "utf8");
    tasks = parseTaskMd(content);
  } catch (err) {
    log(`failed to read ${CRON_FILE}: ${(err as Error).message}`);
    return;
  }

  // Remove tasks that disappeared
  for (const id of [...scheduled.keys()]) {
    if (!tasks.find((t) => t.id === id)) {
      const s = scheduled.get(id)!;
      if (s.timer) clearTimeout(s.timer);
      scheduled.delete(id);
      log(`removed ${id} (no longer in CRON.md)`);
    }
  }

  // Add or update
  for (const task of tasks) {
    const existing = scheduled.get(task.id);
    if (existing) {
      // Only reschedule if cron or prompt changed
      if (existing.task.cron === task.cron && existing.task.prompt === task.prompt) {
        continue;
      }
      if (existing.timer) clearTimeout(existing.timer);
    }
    let fields: CronFields;
    try {
      fields = parseCron(task.cron);
    } catch (err) {
      log(`SKIP ${task.id}: bad cron "${task.cron}": ${(err as Error).message}`);
      continue;
    }
    const s: Scheduled = { task, fields };
    scheduled.set(task.id, s);
    scheduleNext(s);
  }
  log(`loaded ${scheduled.size} task(s)`);
}

// ---- Main -----------------------------------------------------------------

log(`cron-daemon starting (root=${ROOT})`);
loadAndSchedule();

let reloadDebounce: Timer | undefined;
watch(CRON_FILE, () => {
  if (reloadDebounce) clearTimeout(reloadDebounce);
  reloadDebounce = setTimeout(() => {
    log("CRON.md changed; reloading");
    loadAndSchedule();
  }, 500);
});

const stop = (sig: string) => {
  log(`received ${sig}; exiting`);
  for (const s of scheduled.values()) if (s.timer) clearTimeout(s.timer);
  process.exit(0);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
