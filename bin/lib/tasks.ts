/**
 * tasks.ts — background task records for tg-daemon's long-running queries.
 *
 * Each offloaded task is one JSON record in data/tasks/, written by
 * bin/task-runner.ts and read by tg-daemon (injected into event JSON as
 * `background_tasks`). Records are the single source of truth for task
 * state; the reaper in listTasks() flips orphaned "running" records to
 * "failed" so a crashed worker can't look in-flight forever.
 *
 * All functions take an optional dir (default data/tasks) so tests can run
 * against a temp directory.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";

export const DEFAULT_TASKS_DIR = "data/tasks";

// Grace added to a task's own timeout before the reaper declares it dead
// even when the pid still answers (covers a wedged claude the runner's
// kill failed to take down).
const REAP_GRACE_MIN = 5;
// How long finished tasks stay visible in tasksForEvent().
const FINISHED_VISIBLE_MIN = 60;
const PRUNE_MAX_AGE_DAYS = 7;

export interface TaskRecord {
  id: string;              // <YYYYMMDD-HHMMSS>-<slug>
  title: string;
  chat_id: number;
  status: "running" | "done" | "failed";
  started_at: string;      // ISO
  finished_at?: string;
  pid?: number;            // detached worker pid
  prompt_path: string;
  output_path: string;
  timeout_min: number;
  result_summary?: string;
  error?: string;
}

export interface TaskEventEntry {
  id: string;
  title: string;
  status: TaskRecord["status"];
  minutes_ago: number;     // since started_at (running) or finished_at (done/failed)
}

export function makeTaskId(title: string, now: Date = new Date()): string {
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15); // YYYYMMDD-HHMMSS
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "task";
  return `${ts}-${slug}`;
}

export function taskPaths(id: string, dir: string = DEFAULT_TASKS_DIR) {
  return {
    record: join(dir, `${id}.json`),
    prompt: join(dir, `${id}.prompt.md`),
    output: join(dir, `${id}.out.log`),
  };
}

export function writeTask(rec: TaskRecord, dir: string = DEFAULT_TASKS_DIR): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(taskPaths(rec.id, dir).record, JSON.stringify(rec, null, 2) + "\n");
}

export function readTask(id: string, dir: string = DEFAULT_TASKS_DIR): TaskRecord | null {
  try {
    return JSON.parse(readFileSync(taskPaths(id, dir).record, "utf8")) as TaskRecord;
  } catch {
    return null;
  }
}

export function updateTask(
  id: string,
  patch: Partial<TaskRecord>,
  dir: string = DEFAULT_TASKS_DIR,
): TaskRecord | null {
  const rec = readTask(id, dir);
  if (!rec) return null;
  const next = { ...rec, ...patch };
  writeTask(next, dir);
  return next;
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// List all task records, reaping stale "running" ones (dead pid, or past
// timeout+grace) to "failed" on disk as a side effect.
export function listTasks(dir: string = DEFAULT_TASKS_DIR, now: Date = new Date()): TaskRecord[] {
  if (!existsSync(dir)) return [];
  const out: TaskRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let rec: TaskRecord;
    try {
      rec = JSON.parse(readFileSync(join(dir, f), "utf8")) as TaskRecord;
    } catch {
      continue;
    }
    if (!rec.id || !rec.status) continue;
    if (rec.status === "running") {
      const ageMin = (now.getTime() - new Date(rec.started_at).getTime()) / 60_000;
      const overdue = ageMin > rec.timeout_min + REAP_GRACE_MIN;
      if (overdue || !pidAlive(rec.pid)) {
        rec = {
          ...rec,
          status: "failed",
          finished_at: now.toISOString(),
          error: overdue ? "reaped: exceeded timeout" : "reaped: worker process died",
        };
        writeTask(rec, dir);
      }
    }
    out.push(rec);
  }
  return out;
}

// Compact view for tg-daemon's event JSON: all running tasks + tasks that
// finished within the last hour. Running first, then most recent first.
export function tasksForEvent(dir: string = DEFAULT_TASKS_DIR, now: Date = new Date()): TaskEventEntry[] {
  const entries: TaskEventEntry[] = [];
  for (const rec of listTasks(dir, now)) {
    const ref = rec.status === "running" ? rec.started_at : rec.finished_at;
    if (!ref) continue;
    const minutesAgo = Math.round((now.getTime() - new Date(ref).getTime()) / 60_000);
    if (rec.status !== "running" && minutesAgo > FINISHED_VISIBLE_MIN) continue;
    entries.push({ id: rec.id, title: rec.title, status: rec.status, minutes_ago: minutesAgo });
  }
  return entries.sort((a, b) => {
    if ((a.status === "running") !== (b.status === "running")) {
      return a.status === "running" ? -1 : 1;
    }
    return a.minutes_ago - b.minutes_ago;
  });
}

// Delete record/prompt/output files of tasks finished (or started) more
// than maxAgeDays ago. Returns number of tasks deleted. listTasks() runs
// first so an ancient stuck-"running" record gets reaped, then pruned.
export function pruneTasks(
  dir: string = DEFAULT_TASKS_DIR,
  maxAgeDays: number = PRUNE_MAX_AGE_DAYS,
  now: Date = new Date(),
): number {
  let deleted = 0;
  for (const rec of listTasks(dir, now)) {
    const ref = rec.finished_at ?? rec.started_at;
    const ageDays = (now.getTime() - new Date(ref).getTime()) / 86_400_000;
    if (rec.status === "running" || ageDays <= maxAgeDays) continue;
    const paths = taskPaths(rec.id, dir);
    for (const p of [paths.record, paths.prompt, paths.output]) {
      rmSync(p, { force: true });
    }
    deleted++;
  }
  return deleted;
}
