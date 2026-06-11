import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  type TaskRecord,
  makeTaskId,
  taskPaths,
  writeTask,
  readTask,
  updateTask,
  listTasks,
  tasksForEvent,
  pruneTasks,
} from "./tasks";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const id = overrides.id ?? makeTaskId("water heater research", new Date("2026-06-11T10:00:00Z"));
  const paths = taskPaths(id, dir);
  return {
    id,
    title: "water heater research",
    chat_id: 12345,
    status: "running",
    started_at: new Date().toISOString(),
    pid: process.pid, // alive by definition
    prompt_path: paths.prompt,
    output_path: paths.output,
    timeout_min: 30,
    ...overrides,
  };
}

describe("makeTaskId", () => {
  test("timestamp prefix + slugified title", () => {
    const id = makeTaskId("Deep Research: 热水器 A/B 对比!", new Date("2026-06-11T10:05:09Z"));
    expect(id).toMatch(/^\d{8}-\d{6}-deep-research-a-b/);
    expect(id).not.toMatch(/[^a-z0-9-]/);
  });

  test("empty-ish title still yields a valid id", () => {
    const id = makeTaskId("！！！", new Date("2026-06-11T10:05:09Z"));
    expect(id).toMatch(/^\d{8}-\d{6}-task$/);
  });
});

describe("write/read/update round-trip", () => {
  test("writeTask then readTask returns the same record", () => {
    const rec = makeRecord();
    writeTask(rec, dir);
    expect(readTask(rec.id, dir)).toEqual(rec);
  });

  test("readTask returns null for unknown id", () => {
    expect(readTask("nope", dir)).toBeNull();
  });

  test("updateTask merges a patch and persists it", () => {
    const rec = makeRecord();
    writeTask(rec, dir);
    const updated = updateTask(rec.id, { status: "done", result_summary: "answer" }, dir);
    expect(updated?.status).toBe("done");
    expect(readTask(rec.id, dir)?.result_summary).toBe("answer");
  });
});

describe("listTasks reaping", () => {
  test("running task with live pid and fresh start stays running", () => {
    writeTask(makeRecord(), dir);
    expect(listTasks(dir)[0].status).toBe("running");
  });

  test("running task with dead pid is reaped to failed", () => {
    writeTask(makeRecord({ pid: 4_999_999 }), dir);
    const [t] = listTasks(dir);
    expect(t.status).toBe("failed");
    // reap is persisted, not just in-memory
    expect(readTask(t.id, dir)?.status).toBe("failed");
    expect(readTask(t.id, dir)?.finished_at).toBeTruthy();
  });

  test("running task past timeout+grace is reaped even with live pid", () => {
    const old = new Date(Date.now() - 40 * 60_000).toISOString(); // 40min ago, timeout 30+5
    writeTask(makeRecord({ started_at: old }), dir);
    expect(listTasks(dir)[0].status).toBe("failed");
  });

  test("finished tasks are never reaped", () => {
    writeTask(makeRecord({ status: "done", pid: 4_999_999, finished_at: new Date().toISOString() }), dir);
    expect(listTasks(dir)[0].status).toBe("done");
  });

  test("malformed json files are skipped", () => {
    writeFileSync(join(dir, "garbage.json"), "{not json");
    writeTask(makeRecord(), dir);
    expect(listTasks(dir)).toHaveLength(1);
  });
});

describe("tasksForEvent", () => {
  test("includes running tasks with minutes_ago", () => {
    const started = new Date(Date.now() - 5 * 60_000).toISOString();
    writeTask(makeRecord({ started_at: started }), dir);
    const evs = tasksForEvent(dir);
    expect(evs).toHaveLength(1);
    expect(evs[0].status).toBe("running");
    expect(evs[0].minutes_ago).toBeGreaterThanOrEqual(4);
    expect(evs[0].minutes_ago).toBeLessThanOrEqual(6);
  });

  test("includes recently finished, excludes old finished", () => {
    const recent = makeRecord({
      id: "20260611-100000-recent",
      status: "done",
      finished_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const old = makeRecord({
      id: "20260611-090000-old",
      status: "done",
      finished_at: new Date(Date.now() - 120 * 60_000).toISOString(),
    });
    writeTask(recent, dir);
    writeTask(old, dir);
    const evs = tasksForEvent(dir);
    expect(evs.map((e) => e.id)).toEqual(["20260611-100000-recent"]);
  });

  test("running tasks sort before finished ones", () => {
    writeTask(makeRecord({ id: "20260611-100000-done", status: "done", finished_at: new Date().toISOString() }), dir);
    writeTask(makeRecord({ id: "20260611-100001-run" }), dir);
    const evs = tasksForEvent(dir);
    expect(evs[0].id).toBe("20260611-100001-run");
  });
});

describe("pruneTasks", () => {
  test("deletes record + prompt + output files older than maxAgeDays", () => {
    const oldIso = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
    const rec = makeRecord({ status: "done", started_at: oldIso, finished_at: oldIso });
    writeTask(rec, dir);
    writeFileSync(rec.prompt_path, "brief");
    writeFileSync(rec.output_path, "log");
    const fresh = makeRecord({ id: "20260611-110000-fresh", status: "done", finished_at: new Date().toISOString() });
    writeTask(fresh, dir);

    const deleted = pruneTasks(dir);
    expect(deleted).toBe(1);
    expect(existsSync(taskPaths(rec.id, dir).record)).toBe(false);
    expect(existsSync(rec.prompt_path)).toBe(false);
    expect(existsSync(rec.output_path)).toBe(false);
    expect(readTask(fresh.id, dir)).toBeTruthy();
  });

  test("no-op on missing dir", () => {
    expect(pruneTasks(join(dir, "does-not-exist"))).toBe(0);
  });
});
