# tg-daemon Context Behavior

How the Telegram daemon's inner `claude -p` subprocess handles big messages
and reloads conversation history. Living reference — update if you change
the rotation policy or PRIMING.

## Rotation triggers (`bin/tg-daemon.ts`)

```
rotate when:
  turns >= MAX_TURNS                                   (50)
  OR age >= MAX_AGE_MS                                 (8h)
  OR (cache_read > MAX_CACHE_READ AND turns >= MIN)    (600K AND turns >= 5)
```

The 5-turn floor exists to prevent same-turn rotation loops: a single 200K
photo Read on turn 1 would otherwise trigger rotation on the very turn that
needed it, so the next turn would re-Read the same photo and loop.

---

## What happens with a single 300K-token message?

| Turn | cache_read (loaded) | cache_creation (new) | rotation check |
|---|---|---|---|
| N (the big one) | 20K | 300K | `lastCacheRead = 20K` → no rotation |
| N+1 (any next msg) | ~320K | small | `lastCacheRead = 320K` → still < 500K |
| N+2 | ~325K | small | climbing |
| ...eventually | > 500K | — | **rotates** |

A single fat turn does NOT trigger immediate rotation. The model gets
several turns to actually use the big content before the daemon decides to
drop it. Rotation right after a Read would be wasteful — you'd lose the
thing you just paid for.

### Edge case: a SINGLE turn larger than 500K

E.g. a huge PDF.

- Turn N: cache_read=20K, cache_creation=800K → no rotation (lastCacheRead
  is still the old 20K)
- Turn N+1: cache_read=~820K → > 500K → **rotation on the next event**

Result: you get one full turn to engage, then the daemon drops the cost.

### Hard ceiling

Opus's context window is 1M tokens. If a single Read tries to pull a 2M
PDF, the API call itself fails. The daemon surfaces an error to the user.
Rare in practice unless someone uploads a giant file.

---

## How previous conversations get loaded

It's pull-based, not push-based. The daemon does NOT pre-load anything
into the inner claude. The inner claude decides what to Read based on the
rules in PRIMING:

```
FIRST turn after spawn:
  → Read today's data/conversations/YYYY-MM-DD.md
  (unless the message is trivial like "你好")

SUBSEQUENT turns (same spawn):
  → Don't re-read. Rely on in-context memory of prior turns.
  → EXCEPT when:
    (a) user references past ("yesterday", "earlier", "我之前说过"),
    (b) reply_to.from_bot=true (find the original bot message),
    (c) event has external_writes_since_last_turn (cron wrote to log) —
        already inlined in the event, no Read needed.

ACROSS rotations (within same day):
  → New claude's first turn reads today's log → recovers continuity.

ACROSS days:
  → If user says "yesterday I told you...", claude reads
    data/conversations/2026-05-03.md on demand.
```

### Concrete flow for a 25-turn rotation

```
Turn 1  (after rotation): claude reads data/conversations/<today>.md (~5K tokens)
                          → caches → answers
Turn 2:  no re-read, in-context memory carries
Turn 3:  no re-read
...
Turn 25: rotation triggered
Turn 26: NEW claude → reads data/conversations/<today>.md again
        (now ~7K, has grown) → caches fresh → answers
```

So the cost is **one log-Read per spawn**, not per turn. The disk file is
the source of truth that survives rotations.

### Image/PDF preservation across rotation

The conversation log is text-only. Image bytes are at
`data/attachments/<message_id>.<ext>` separately. After rotation, the new
claude reads the log and sees the bot's prior text reply (which describes
the image), not the image itself. PRIMING instructs the model to write
descriptive replies for this reason — e.g. say
`"好看! 这盘麻婆豆腐看起来很正宗"` instead of just `"好看!"` so future
sessions can understand the photo context without re-Reading 16K tokens.

If the user later refers to the photo, the new claude can re-Read it from
disk.

### A wrinkle

The log just grows. By end of day a chatty day's log can hit ~30K tokens
(~120KB). Each rotation = re-read at full size. If this becomes painful,
options:

- Auto-compress older log entries at rotation time (summarize first half of
  day, keep recent verbatim).
- Skip log re-read if last turn was <5min ago (preserve in-context memory
  through quick rotations).

Neither needed yet. Current design trades ~5–30K tokens per rotation for
total simplicity.

---

## Background tasks (concurrent long-running queries)

Turns in the inner claude are strictly serialized, so long work would
block every later message and die at the 15-min turn timeout. Instead,
PRIMING teaches the model to offload anything needing >~2 min of tool
work to a detached one-shot worker:

```
inner claude:  writes self-contained brief → bun run bin/task-runner.ts start
               replies "在查了～" immediately            (lane free again)
worker:        fresh `claude -p` (env-stripped, 30-min default timeout)
               → tg-sends result + appends to data/conversations/<date>.md
inner claude:  sees the result via external_writes_since_last_turn next turn
```

State lives in `data/tasks/<id>.json` (`bin/lib/tasks.ts`). The daemon
injects `background_tasks: [{id,title,status,minutes_ago}]` (running +
finished <1h) into every event so the model can answer progress questions
and dedupe spawns. Stale `running` records (dead pid or past
timeout+5min) are reaped to `failed` at read time; files >7 days old are
pruned at daemon spawn.

Cache effect: the main session's prefix and append-only context are
untouched (every interactive turn stays cache_read-dominated), and fat
research turns no longer push `cache_read` toward the rotation threshold
— the warm cache survives *longer*. Workers pay one isolated
cache_creation and exit.

Design doc: `docs/superpowers/specs/2026-06-11-tg-daemon-background-tasks-design.md`.

---

## Knobs

All in `bin/tg-daemon.ts`:

```ts
const MAX_TURNS = 50;
const MAX_AGE_MS = 8 * 60 * 60 * 1000;
const MAX_CACHE_READ = 600_000;
const MIN_TURNS_FOR_CACHE_ROTATION = 5;
```

Background-task knobs in `bin/task-runner.ts` / `bin/lib/tasks.ts`:
`DEFAULT_TIMEOUT_MIN = 30`, `REAP_GRACE_MIN = 5`,
`FINISHED_VISIBLE_MIN = 60`, `PRUNE_MAX_AGE_DAYS = 7`.

To monitor live: `bun run bin/daemon-stats.ts` (or text the bot `/stats`);
`bun run bin/task-runner.ts list` dumps task records.
