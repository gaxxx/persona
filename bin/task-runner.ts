#!/usr/bin/env bun
/**
 * task-runner.ts — detached background worker for long-running queries.
 *
 * The tg-daemon's inner claude offloads anything needing sustained tool work
 * here so the main conversation lane stays responsive (see
 * docs/superpowers/specs/2026-06-11-tg-daemon-background-tasks-design.md).
 *
 *   start --chat <id> --title <slug> [--timeout <min>] --prompt-file <path>
 *       Create the task record, spawn a detached `run` worker, print
 *       `started <task-id>`, exit immediately (sub-second — safe to call
 *       from inside a claude turn). Brief may also be piped on stdin.
 *
 *   run <id>      (internal) Execute the task with a one-shot `claude -p`,
 *                 send the result to Telegram, log it to the conversation
 *                 file (which feeds tg-daemon's external-writes injection),
 *                 update the record.
 *
 *   list          Print current task records (debugging).
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import {
  makeTaskId,
  taskPaths,
  writeTask,
  readTask,
  updateTask,
  listTasks,
  type TaskRecord,
} from "./lib/tasks";
import { runClaude, logToConversation } from "./lib/cron-helpers";
import { sendMessage } from "./lib/telegram";

const ROOT = resolve(import.meta.dir, "..");
const TASKS_DIR = resolve(ROOT, "data/tasks");
const DEFAULT_TIMEOUT_MIN = 30;

const WORKER_PREAMBLE = `You are a one-shot background worker spawned by the Telegram assistant daemon to handle a long-running task while the main conversation stays responsive. cwd is the persona repo root; read CLAUDE.md for conventions (resolve <vault> from $VAULT_PATH).

You are a FRESH session with no memory of the conversation. The task brief below should be self-contained, but if it references the ongoing conversation, read today's data/conversations/<date>.md (get the date via \`bun run bin/lib/user-tz.ts\`) and data/scratchpad.md for context.

Output contract:
- The FINAL text you print is sent to the user on Telegram verbatim by the runner. Write it in the user's language (per USER.md), concise and Telegram-sized — a few short paragraphs at most, no "here is the result" preamble.
- Persist large artifacts (full reports, comparison tables, files) via /kb put and mention where they live; do not dump them into the final text.
- You MAY send files with bin/tg-send-doc.ts / bin/tg-send-photo.ts. Do NOT call bin/tg-send.ts for plain text — the runner delivers your final text.
- Do NOT start watchers or daemons, do NOT call tg-pull.ts, do NOT poll Telegram.

Task brief:
---
`;

function usage(): never {
  console.error(
    "usage: task-runner.ts start --chat <id> --title <slug> [--timeout <min>] [--prompt-file <path>]\n" +
      "       (brief from --prompt-file or stdin)\n" +
      "       task-runner.ts run <task-id>   (internal)\n" +
      "       task-runner.ts list",
  );
  process.exit(1);
}

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith("--") || argv[i + 1] === undefined) usage();
    flags[argv[i].slice(2)] = argv[i + 1];
  }
  return flags;
}

async function start(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const chatId = Number(flags.chat);
  const title = (flags.title ?? "").trim();
  const timeoutMin = flags.timeout ? Number(flags.timeout) : DEFAULT_TIMEOUT_MIN;
  if (!Number.isFinite(chatId) || chatId === 0 || !title || !Number.isFinite(timeoutMin) || timeoutMin <= 0) usage();

  const brief = flags["prompt-file"]
    ? readFileSync(flags["prompt-file"], "utf8").trim()
    : (await Bun.stdin.text()).trim();
  if (!brief) {
    console.error("task-runner: empty task brief");
    process.exit(1);
  }

  const id = makeTaskId(title);
  const paths = taskPaths(id, TASKS_DIR);
  mkdirSync(dirname(paths.prompt), { recursive: true });
  writeFileSync(paths.prompt, brief + "\n");
  const rec: TaskRecord = {
    id,
    title,
    chat_id: chatId,
    status: "running",
    started_at: new Date().toISOString(),
    // Our own pid keeps the record alive past the reaper until the detached
    // worker's pid replaces it (in run()).
    pid: process.pid,
    prompt_path: paths.prompt,
    output_path: paths.output,
    timeout_min: timeoutMin,
  };
  writeTask(rec, TASKS_DIR);

  // Detached + own stdio so the worker survives the spawning claude turn's
  // process-group cleanup and nothing holds the caller's pipes open.
  const out = openSync(paths.output, "a");
  const child = spawn(process.execPath, ["run", resolve(import.meta.path), "run", id], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  if (child.pid) updateTask(id, { pid: child.pid }, TASKS_DIR);
  console.log(`started ${id}`);
  process.exit(0);
}

async function run(id: string): Promise<void> {
  const rec = readTask(id, TASKS_DIR);
  if (!rec) {
    console.error(`task-runner run: unknown task ${id}`);
    process.exit(1);
  }
  updateTask(id, { pid: process.pid }, TASKS_DIR);
  const brief = readFileSync(rec.prompt_path, "utf8");
  try {
    const result = (await runClaude(WORKER_PREAMBLE + brief, rec.timeout_min * 60_000)).trim();
    if (!result) throw new Error("worker produced empty output");
    // Persist the answer before attempting delivery — a Telegram hiccup must
    // not throw away a 30-minute run. Full text goes to the out.log.
    writeFileSync(rec.output_path, `\n--- result ---\n${result}\n`, { flag: "a" });
    updateTask(id, { result_summary: result.slice(0, 300) }, TASKS_DIR);
    await sendMessage(rec.chat_id, result);
    logToConversation(`[后台任务完成 task:${rec.title}] ${result}`);
    updateTask(id, { status: "done", finished_at: new Date().toISOString() }, TASKS_DIR);
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`task ${id} failed:`, msg);
    updateTask(id, { status: "failed", finished_at: new Date().toISOString(), error: msg.slice(0, 500) }, TASKS_DIR);
    try {
      await sendMessage(rec.chat_id, `😔 后台任务「${rec.title}」失败了，没拿到结果。要不要换个方式再试一次？`);
      logToConversation(`[后台任务失败 task:${rec.title}] ${msg.slice(0, 200)}`);
    } catch (se) {
      console.error("failure notification failed:", (se as Error).message);
    }
    process.exit(1);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "start") await start(rest);
else if (cmd === "run" && rest[0]) await run(rest[0]);
else if (cmd === "list") console.log(JSON.stringify(listTasks(TASKS_DIR), null, 2));
else usage();
