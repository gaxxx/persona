---
name: assistant-loop
description: Personal assistant loop. Three independent contexts - Telegram I/O (tg-daemon), scheduled tasks (cron-daemon), and main REPL (interactive + heartbeat). Consults CLAUDE.md for what to do; this skill handles how.
---

# Assistant Loop

The assistant runs in **three parallel contexts** that share the same filesystem and persona but talk to different audiences. They are independent processes - none is blocked by the others.

| Context | Scope | Started by |
|---|---|---|
| **tg-daemon** (`bin/tg-daemon.ts`) | Telegram I/O - receives Telegram messages and sends replies via a long-lived `claude -p --input-format stream-json` subprocess | `nohup bun run bin/tg-daemon.ts &` |
| **cron-daemon** (`bin/cron-daemon.ts`) | Scheduled tasks from `TASK.md` (gmail digest, daily journal, morning brief). On fire, spawns a one-shot `claude -p --permission-mode bypassPermissions` to handle the prompt. Auto-reloads on `TASK.md` change. | `nohup bun run bin/cron-daemon.ts &` |
| **Main REPL** (this Claude Code session) | Interactive session for ad-hoc work + daemon health heartbeat | User runs `/loop /assistant-loop` |

## Channel Discipline (information isolation)

**Reply on the channel the request came in on.** Don't cross-post.

- **Telegram message arrives** -> daemon's claude subprocess replies on Telegram (`bun run bin/tg-send.ts <chat_id> "<msg>"`). Don't echo anything to the REPL.
- **REPL command** typed by your human in this Claude Code session -> reply only in REPL output. Do **not** send a Telegram message unless they explicitly ask ("send to telegram"/"tell me on telegram").
- **Cron-fired tasks** (gmail digest, daily journal, morning brief) - push results to Telegram per their TASK.md prompt. REPL gets only a brief status line.
- **Heartbeat ticks** - normally silent (just check daemon health + reschedule). **Send Telegram alert** when there's a real issue worth interrupting the user: daemon was dead and got restarted, daemon failed to restart, daemon hasn't processed any message in >1h despite Telegram updates being available, etc. Don't alert for routine ticks.

When in doubt, prefer one channel - the one that originated the request.

## Daemon - On Telegram Event

The daemon feeds the claude subprocess one user turn per Telegram event. Event shape:

```json
{ "chat_id": ..., "from": "...", "text": "...",
  "attachment": { "kind": "photo|document|sticker", "path": "data/attachments/...", "name": ..., "mime": ... } | undefined,
  "reply_to": { "message_id": ..., "from_bot": bool, "text": "...", "attachment_kind": ..., "attachment_name": ... } | undefined,
  "date": "...", "message_id": ... }
```

Steps when handling an event:

1. Send typing indicator: `bun run bin/tg-typing.ts <chat_id>`
2. **Log incoming** - append to `data/conversations/YYYY-MM-DD.md`.
3. **Load conversation context** - read recent conversation files (today + recent days). If total < 10K chars include all; otherwise summarize older days and keep today verbatim.
4. **If `attachment` set** - Read it via the Read tool (Read supports images and PDFs natively).
5. **If `reply_to` set** - Use as context for what the user is responding to. If `reply_to.from_bot` is true, find that earlier message in `data/conversations/` for full context. If the replied-to had an attachment, look in `data/attachments/<reply_to.message_id>.*`.
6. If onboarding not done (`USER.md` has "not set" fields) -> run onboarding flow.
7. **Check available skills and MCP tools.** Pick the best fit, or reply directly if none applies.
8. Send: `bun run bin/tg-send.ts <chat_id> "<response>"`
9. **Log outgoing** - append to today's conversation file.

The daemon **only** owns Telegram. It does NOT start a Monitor, does NOT call `bin/tg-pull.ts`, and does NOT register crons.

## Main REPL - First Tick

1. **Verify both daemons are running** - `pgrep -af tg-daemon.ts` and `pgrep -af cron-daemon.ts`. If either is down, start it:
   ```bash
   nohup bun run bin/tg-daemon.ts   > /tmp/tg-daemon-stderr.log   2>&1 & disown
   nohup bun run bin/cron-daemon.ts > /tmp/cron-daemon-stderr.log 2>&1 & disown
   ```
   Wait ~6s. Confirm tg-daemon via `grep "priming complete" /tmp/tg-daemon-stderr.log`. Confirm cron-daemon via `grep "loaded . task" /tmp/cron-daemon-stderr.log`.

2. **Re-arm pending reminders** - read `<vault>/persona/tasks.md` for incomplete tasks with future dates. Add them as cron entries in `TASK.md` (cron-daemon picks them up via fs.watch) or send overdue ones immediately via Telegram with a note.

3. Schedule fallback heartbeat via `ScheduleWakeup` (1200s).

The main REPL does **not** poll Telegram (tg-daemon owns that), does **not** schedule cron tasks (cron-daemon owns that), and does **not** handle scheduled-task prompts (those run as headless `claude -p` subprocesses spawned by cron-daemon).

## Main REPL - On ScheduleWakeup (heartbeat)

Check both daemons.

1. **tg-daemon** (`pgrep -af tg-daemon.ts`):
   - Alive -> silent.
   - Dead -> restart (`nohup bun run bin/tg-daemon.ts ...`), wait for `priming complete`. Telegram alert: `🦌 tg-daemon was down, restarted (PID <pid>)`. If restart fails (no priming after ~15s), Telegram: `⚠️ tg-daemon failed to restart, manual intervention` + last 5 lines of `/tmp/tg-daemon-stderr.log`.
2. **cron-daemon** (`pgrep -af cron-daemon.ts`):
   - Alive -> silent.
   - Dead -> restart (`nohup bun run bin/cron-daemon.ts ...`), wait for `loaded . task`. Telegram alert: `⏰ cron-daemon was down, restarted`.
3. Reschedule heartbeat (1200s).

## How cron tasks run (background)

The main REPL does NOT see cron fires anymore - they run in independent processes spawned by cron-daemon. Each cron entry in `TASK.md`:

- cron-daemon sets a `setTimeout` to its next fire time
- on fire, cron-daemon spawns `claude -p --permission-mode bypassPermissions <prompt>` with cwd=repo root and inherited env
- that subprocess does the work (reads CLAUDE.md, hits MCPs, sends Telegram per the prompt) and exits
- cron-daemon logs the fire to `data/cron.log` and reschedules

If you edit `TASK.md` (add/remove tasks, change cron expression, change prompt), cron-daemon's fs.watch picks it up automatically (500ms debounce). No restart needed. The "Last run" line that each task self-updates is preserved across reloads (cron expression and prompt are the only fields cron-daemon actually reads at schedule time).

## Onboarding (first-time setup)

Triggered on the first Telegram message when `USER.md` has "not set" fields:

1. Greet warmly. Ask them to introduce themselves: name, location, timezone, preferred language. Or let them write freely - extract from natural conversation.
2. Update `USER.md` with what you learn (name, location, timezone, language, telegram chat_id).
3. Fill in `IDENTITY.md` - pick a name, creature type, vibe, and emoji from conversation tone.
4. Confirm naturally, then handle their original message (don't make them repeat).

One or two questions max. Learn the rest over time.

## Conversation Log

All Telegram messages and responses log to `data/conversations/YYYY-MM-DD.md`:

```
[HH:MM] user: message text
[HH:MM] bot: response text
```

The daemon writes both halves. The main REPL does NOT write to this file (REPL conversations are separate - they live in this Claude Code session's transcript and don't get logged).

## Telegram Commands (reference)

```bash
bun run bin/tg-send.ts <chat_id> "<message>"   # send (used by tg-daemon's inner claude + cron-daemon-spawned tasks)
bun run bin/tg-typing.ts <chat_id>             # typing indicator (tg-daemon only)
bun run bin/tg-daemon.ts                       # Telegram daemon entry point
bun run bin/cron-daemon.ts                     # cron daemon entry point
```

`bin/tg-pull.ts` and `bin/tg-watch.ts` are legacy from the pre-daemon architecture. Don't use.

## Error Handling

- If a script fails, log the error and continue. Never let an error stop the loop - always reschedule the heartbeat.
- If tg-daemon's inner claude subprocess dies mid-turn, tg-daemon respawns it and re-sends the priming.
- If tg-daemon or cron-daemon themselves die, the heartbeat detects via `pgrep` and restarts the missing one(s).
- If a single cron fire fails (claude subprocess errors out), cron-daemon logs and continues with the schedule - one bad fire doesn't break future fires.
