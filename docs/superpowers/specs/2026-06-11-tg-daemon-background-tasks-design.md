# tg-daemon Background Tasks — Concurrent Long-Running Queries

**Date:** 2026-06-11
**Status:** Approved (autonomous goal session; user to review)

## Problem

`bin/tg-daemon.ts` routes every Telegram message into a single persistent
`claude -p` stream-json subprocess, and turns are strictly serialized
(promise chain in `enqueue`). Consequences:

1. **Head-of-line blocking.** A long query (deep research, multi-site
   crawl, big document analysis) occupies the only lane. Every later
   message queues behind it for minutes.
2. **Timeout ceiling.** Turns are killed at 15 min total / 5 min idle, so
   genuinely long work can't finish inline at all.
3. **Cache pressure.** A fat research turn adds 100K+ tokens to the main
   session's context, racing it toward the `MAX_CACHE_READ` rotation —
   each rotation throws away the warm cache and re-reads the day's log.

The persistent single session is also what makes the daemon cheap: its
context is append-only and its PRIMING prefix is stable, so every turn is
mostly `cache_read`. Any design must preserve that.

## Approaches considered

**A. Model-side delegation to detached one-shot workers (chosen).**
Main session stays the only persistent lane. PRIMING teaches the model to
recognize long-running requests and offload them to a detached
`claude -p` worker via a new `bin/task-runner.ts`, replying to the user
immediately. The worker sends its answer to Telegram itself and appends
it to the conversation log; the existing `external_writes_since_last_turn`
mechanism injects that back into the main session's context on its next
turn. Pros: zero change to the main session's cache profile (it actually
improves — long work no longer bloats context toward rotation); reuses
proven patterns (cron's `runClaude`, `logToConversation`, external-writes
injection, pull-based context recovery); the model — not a daemon
heuristic — judges what is "long". Cons: relies on model compliance
(backstopped by the existing turn timeouts).

**B. Daemon-side subprocess pool / dual lane.** Daemon classifies
messages and routes long ones to a second persistent subprocess.
Rejected: the daemon can't classify reliably without an LLM call; a
second persistent session doubles idle context cost and splits
conversational state into two diverging histories.

**C. Session forking (`claude -p --resume <sid> --fork-session`) for
workers.** Would give workers full conversational context plus prompt-
cache hits on the shared prefix. Rejected for v1: forking happens
mid-turn (the spawning turn is still in flight), so the on-disk
transcript may end in a dangling tool_use — fragile. The pull-based
alternative (worker reads today's conversation log + scratchpad, same as
post-rotation recovery) is proven and good enough. Revisit as an
optimization.

## Design

### Components

```
bin/lib/tasks.ts      task records: create/update/list/prune (testable, pure file I/O)
bin/task-runner.ts    CLI: `start` (spawn detached worker, exits fast) + `run` (worker)
bin/tg-daemon.ts      + inject `background_tasks` into event JSON
                      + PRIMING offload rules
                      + prune task files on spawn
```

### Task records — `data/tasks/<id>.json`

```ts
interface TaskRecord {
  id: string;              // <YYYYMMDD-HHMMSS>-<slug>
  title: string;           // short human slug, shown in event JSON
  chat_id: number;
  status: "running" | "done" | "failed";
  started_at: string;      // ISO
  finished_at?: string;
  pid?: number;            // worker pid, for liveness checks
  prompt_path: string;     // data/tasks/<id>.prompt.md
  output_path: string;     // data/tasks/<id>.out.log (worker stdout/stderr)
  timeout_min: number;     // default 30
  result_summary?: string; // first 300 chars of the result
  error?: string;
}
```

Stale detection: a `running` record whose worker pid is dead, or whose
age exceeds `timeout_min + 5`, is flipped to `failed` at read time (the
daemon reads on every event, so this is the reaper). Files older than 7
days are pruned at daemon spawn.

### `task-runner.ts start`

```
bun run bin/task-runner.ts start --chat <id> --title <slug> \
    [--timeout <min>] --prompt-file <path>     # or brief on stdin
```

Creates the record, then re-spawns itself detached
(`node:child_process.spawn` with `detached: true`, stdio to the task's
out.log, `unref()`) running `task-runner.ts run <id>`, prints
`started <id>`, exits immediately — so the main session's Bash call
returns in well under a second.

### `task-runner.ts run <id>` (the worker)

Wraps the task brief in a worker preamble and executes it with cron's
existing `runClaude()` (env-stripped, `bypassPermissions`, cwd = repo
root, hard timeout). Preamble tells the worker claude:

- It is a **fresh background session** with no memory of the chat: read
  CLAUDE.md; read today's `data/conversations/<date>.md` and
  `data/scratchpad.md` if the brief references the conversation.
- Its **final stdout is the Telegram reply** — user's language per
  USER.md, concise; persist large artifacts via `/kb put` and reference
  them. May call `tg-send-doc`/`tg-send-photo` for files, but must NOT
  call `tg-send.ts` for the final text (the runner sends it).
- No watchers/daemons/tg-pull.

On success: `sendMessage(chat_id, result)`, `logToConversation(...)`
(which feeds the external-writes injection), record → `done`.
On error/timeout: short apology to the user, record → `failed` with the
error.

### Daemon changes

1. **Event injection.** Alongside `active_threads`, each event gets
   `background_tasks: [{id, title, status, minutes_ago}]` — running
   tasks plus those finished in the last 60 min. Lets the model answer
   progress questions and dedupe spawns without reading files.
2. **PRIMING additions.** New "Background tasks" section:
   - Offload when estimated tool work exceeds ~2 minutes (deep research,
     multi-source crawling, large-corpus analysis). The brief must be
     **self-contained** (worker has no conversation memory): user's
     question verbatim, relevant constraints/candidates from the
     scratchpad thread, expected output language/format.
   - After spawning, reply immediately with an ETA-flavored ack.
   - Never spawn a duplicate for an intent that already has a `running`
     task; at ≥2 running tasks, tell the user and queue.
   - Results arrive via the worker directly; the model sees them in
     `external_writes_since_last_turn` next turn — don't re-answer.
3. **Prune** task files at spawn.

### Data flow

```
user: "帮我深度对比 A/B/C 三款热水器"
  └─ main session: writes brief → task-runner start (sub-second)
     replies "在查了，~10 分钟后给你结果 🔍"          ← lane free again
user: "今晚吃什么?"                                   ← answered immediately
  ... 10 min later ...
worker: tg-send result + append to conversations log
user: "缩短一下第二段"
  └─ event carries external_writes (the worker's answer)
     main session edits with full knowledge of what was sent
```

### Cache-hit rationale

- The main session is untouched: stable PRIMING prefix, append-only
  context → every interactive turn stays `cache_read`-dominated.
- Offloading *removes* the biggest rotation driver (fat research turns),
  so the warm cache survives longer between rotations.
- Workers are one-shot: they pay one `cache_creation` for CLAUDE.md +
  skills and die. That cost existed inline anyway — now it's isolated
  and doesn't compound into the main session's per-turn `cache_read`.
- Injected state stays tiny and stable-shaped (`background_tasks` mirrors
  `active_threads`), and worker results enter the main context as the
  short Telegram reply, not the worker's full research trace.

### Error handling

| Failure | Handling |
|---|---|
| Worker claude exits non-zero / times out | runner messages the user, record → failed |
| Worker process dies silently (jetsam) | pid-liveness reaper flips record at next event |
| `start` called with missing args / empty brief | exits 1 with usage; main session sees Bash error and falls back to inline |
| Duplicate spawn | PRIMING rule + `background_tasks` visibility (soft guard) |
| Telegram send fails post-success | result persisted in `<id>.out.log` + record summary; error logged |

### Testing

`bun test` over `bin/lib/tasks.ts` (dir-parameterized so tests use a
temp dir): create/read round-trip, stale-running reaping (dead pid, age
overrun), `tasksForEvent` shape/window, prune. The runner's spawn
plumbing is kept thin and verified manually (`start` → record →
detached `run` → done).

## Out of scope

- Session forking for workers (v2 optimization, see Approach C).
- Daemon-side task queueing/priorities; progress streaming to Telegram.
- Cancelling a running task from chat (can be added as `task-runner.ts
  cancel <id>` later).
