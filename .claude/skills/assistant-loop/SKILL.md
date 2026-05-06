---
name: assistant-loop
description: Personal assistant loop. Telegram I/O (tg-daemon), scheduled tasks (cron-daemon), and an interactive REPL — supervised by a background bash watchdog so the REPL doesn't need to stay open burning tokens. Consults CLAUDE.md for what to do; this skill handles how.
---

# Assistant Loop

The assistant has **three long-running components** plus an optional REPL:

| Component | Scope | Started by |
|---|---|---|
| **tg-daemon** (`bin/tg-daemon.ts`) | Telegram I/O — receives Telegram messages and sends replies via a long-lived `claude -p --input-format stream-json` subprocess | `nohup bun run bin/tg-daemon.ts &` (or watchdog respawn) |
| **cron-daemon** (`bin/cron-daemon.ts`) | Scheduled tasks from `CRON.md` (gmail digest, daily journal, morning brief). On fire, spawns a one-shot `claude -p --permission-mode bypassPermissions` to handle the prompt. Auto-reloads on `CRON.md` change. | `nohup bun run bin/cron-daemon.ts &` (or watchdog respawn) |
| **watchdog** (`bin/watchdog.sh`) | Bash supervisor (no LLM). Loops every 60s; respawns dead daemon(s) + Telegram alert. | `/assistant-loop` first tick spawns it `& disown` if not already alive. |
| **Main REPL** (this Claude Code session) | Interactive session for ad-hoc work. NO heartbeat — the watchdog handles supervision. | User runs `/assistant-loop` (one-shot) when they want a status check. |

**Cost note:** The REPL no longer schedules wake-ups. Open it when you want to interact, close it when you're done — daemons stay supervised by the watchdog regardless.

## Channel Discipline (information isolation)

**Reply on the channel the request came in on.** Don't cross-post.

- **Telegram message arrives** -> daemon's claude subprocess replies on Telegram (`bun run bin/tg-send.ts <chat_id> "<msg>"`). Don't echo anything to the REPL.
- **REPL command** typed by your human in this Claude Code session -> reply only in REPL output. Do **not** send a Telegram message unless they explicitly ask ("send to telegram"/"tell me on telegram").
- **Cron-fired tasks** (gmail digest, daily journal, morning brief) - push results to Telegram per their CRON.md prompt. REPL gets only a brief status line.
- **Watchdog respawns** — the bash watchdog sends Telegram alerts directly when it restarts a daemon (`🦌 tg-daemon was down, restarting`). REPL doesn't see this; the user gets the message on their phone.

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
3. **Load conversation context** (lazy — the daemon's PRIMING enforces this):
   - **First turn after subprocess spawn**: read today's conversation file. If <10K chars include all; otherwise summarize older days and keep today verbatim.
   - **Subsequent turns**: do NOT re-read by default — your in-context memory of prior turns covers it. Re-read only when (a) the user references past events ("yesterday" / "earlier" / "我之前说过" / "上次"), (b) `reply_to.from_bot=true`, or (c) the event JSON contains an `external_writes_since_last_turn` field — that's the daemon telling you a cron task (or another process) wrote to the log between your turns; treat the field's content as already-read context, no Read needed (unless it ends with a TRUNCATED marker).
   - **Trivial messages** (greetings like "你好" / "thanks" / "👍", or USER.md-derivable questions like "我在哪个时区"): skip the log entirely, even on the first turn.
4. **If `attachment` set** - Read it via the Read tool (Read supports images and PDFs natively).
5. **If `reply_to` set** - Use as context for what the user is responding to. If `reply_to.from_bot` is true, find that earlier message in `data/conversations/` for full context. If the replied-to had an attachment, look in `data/attachments/<reply_to.message_id>.*`.
6. If onboarding not done (`USER.md` has "not set" fields) -> run onboarding flow.
7. **Check available skills and MCP tools.** Pick the best fit, or reply directly if none applies.
8. Send: `bun run bin/tg-send.ts <chat_id> "<response>"`
9. **Log outgoing** - append to today's conversation file.

The daemon **only** owns Telegram. It does NOT start a Monitor, does NOT call `bin/tg-pull.ts`, and does NOT register crons.

## Main REPL — `/assistant-loop` (one-shot)

This skill runs once per invocation. No `ScheduleWakeup`, no heartbeat.

1. **Tag this session as `loop` in the registry** — `bun run bin/register-session.ts loop`. Idempotent; enables `/stats` to bucket billing accurately.

2. **Verify the watchdog is alive** — `pgrep -f bin/watchdog.sh`. If not running, spawn it (it'll come up and immediately catch any dead daemons):
   ```bash
   nohup bash bin/watchdog.sh > /tmp/watchdog.log 2>&1 & disown
   ```

3. **Quick daemon status** — pgrep tg-daemon and cron-daemon. If either is dead, the watchdog will catch them within 60s; for instant feedback you can run `bash bin/watchdog.sh --once` to do a single check now.

4. **Re-arm pending reminders** — read `<vault>/persona/tasks.md` for incomplete tasks with dates ≤ today. Send overdue ones immediately via Telegram with a note. (Future-dated tasks are handled by the `upcoming-1h-preview` cron task, no need to re-arm.)

5. **Report status to the REPL user** in 1–3 lines (e.g., "✓ watchdog up, both daemons healthy, 2 overdue tasks pinged"). Done — no scheduled wake-up.

The main REPL does **not** poll Telegram (tg-daemon owns that), does **not** schedule cron tasks (cron-daemon owns that), and does **not** supervise daemons in a loop (watchdog owns that).

## Upcoming Preview (soft reminders)

A cron task `upcoming-1h-preview` fires every 20 min and pings Telegram for events about to happen. Goal: ONE notification per event, ~15-30 min lead, never spam, respect quiet hours.

**Procedure** (run by the cron-fired `claude -p` subprocess):

1. **Time gate** — Get current local time: `date '+%Y-%m-%dT%H:%M %z'`. Read user's quiet hours from `<vault>/persona/USER.md` (default 23:30-08:00 local). If inside quiet window, skip step 6 (Telegram send) UNLESS the event itself starts inside this same quiet window. Logging/dedup still proceed.

2. **Window** — `[now, now + 30min]`. Anything outside the window is ignored. (30min lead matches typical leave-the-house buffer; smaller window means we never ping too early.)

3. **Dedup state** — Read `data/upcoming-notified.json` (shape: `{ "<event-key>": "<ISO-sent-at>" }`). Create `{}` if missing. Prune entries whose sent-at is > 24h old, write back.

4. **Gather candidates** in the window:
   - **Google Calendar** via `mcp__claude_ai_Google_Calendar__list_events` (or whichever calendar MCP is wired) with `timeMin=now`, `timeMax=now+30min`. Key = `gcal:<event.id>`.
   - **tasks.md** — `<vault>/persona/tasks.md`, `- [ ]` lines with `📅 YYYY-MM-DD` = today AND a parseable time (`15:00`, `下午3点`, `3pm`, etc.) whose computed start falls in the window. Key = `task:<first 12 chars of sha1(line)>`.
   - Skip any candidate whose key is already in dedup state.

5. **Per-event lead override** — If the event title/description (calendar) or task line (tasks.md) contains `lead:Nmin` or `lead:Nh` (e.g. `lead:45min`), use N instead of 30 for that event. Only matters if N > 30 — those events get matched in earlier ticks because we widen step 4 to `now + max(30, lead)` minutes when scanning. Default 30 is fine for most.

6. **Send** — If 0 new candidates → exit silently (no "nothing upcoming" pings). Otherwise compose ONE Telegram message:
   - Format per event: `🔔 ~Nmin: <title> [@ <location-or-context>]`
   - Multiple events: one line each, single send via `bun run bin/tg-send.ts <CHAT_ID> "<msg>"` (chat_id from `<vault>/persona/USER.md`).

7. **Persist** — Add each fired event key to `data/upcoming-notified.json` with current ISO timestamp. Write back.

8. **Log** — Append `[HH:MM] bot: <msg>` to today's `data/conversations/YYYY-MM-DD.md`.

9. **Final stdout line** — print a 1-line summary as the LAST line of stdout, e.g. `2 events` or `silent`. cron-daemon stamps that into the `Last run:` line of CRON.md automatically (don't edit CRON.md yourself).

**Tuning**: window/lead defaults live here, not CRON.md. Change in this file when you want to adjust behavior.

## How cron tasks run (background)

The main REPL does NOT see cron fires anymore - they run in independent processes spawned by cron-daemon. Each cron entry in `CRON.md`:

- cron-daemon sets a `setTimeout` to its next fire time
- on fire, cron-daemon spawns `claude -p --permission-mode bypassPermissions <prompt>` with cwd=repo root and inherited env
- that subprocess does the work (reads CLAUDE.md, hits MCPs, sends Telegram per the prompt) and exits
- cron-daemon logs the fire to `data/cron.log`, then on exit-0 stamps the task's `- **Last run:**` line in CRON.md with the current timestamp + the subprocess's final stdout line as a 1-line summary (truncated to 200 chars). Failed tasks (non-zero exit) leave Last run untouched so the gap is visible.
- Then reschedules.

If you edit `CRON.md` (add/remove tasks, change cron expression, change prompt), cron-daemon's fs.watch picks it up automatically (500ms debounce). No restart needed. Last run lines (whether daemon-written or hand-set) are preserved across reloads — cron-daemon only reads `Cron:` and `Prompt:` at schedule time.

Cron task prompts should print a terse 1-line summary as their final stdout line (the daemon uses it as the Last-run suffix). They should NOT edit CRON.md themselves.

**Two ways to write a cron task**:

1. **Inline prompt**: the `Prompt:` block in CRON.md is the full instruction; cron-daemon spawns `claude -p` directly with it. Best for simple, low-state, occasional tasks.

2. **Deterministic wrapper script** (preferred for repeated/stateful tasks like gmail-digest, daily-journal): write `bin/<task>.ts` that owns the stateful parts (file I/O, dedup, tg-send) and only shells out to `claude -p` for the LLM-only parts (classify, summarize, compose). The CRON.md prompt then becomes a one-liner: ``Run `bun run bin/<task>.ts` and report the final stdout line.`` Shared utilities live in `bin/lib/cron-helpers.ts` (etIsoNow, runClaude, extractJson, tgSend, logToConversation).

The wrapper pattern keeps state machines deterministic and makes failures debuggable as plain script errors, while still using the model where judgment is needed.

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

- If tg-daemon's inner claude subprocess dies mid-turn, tg-daemon respawns it and re-sends the priming.
- If tg-daemon or cron-daemon themselves die, the bash watchdog (`bin/watchdog.sh`) detects via pidfile + `kill -0` within 60s and respawns the missing one(s) + Telegram alerts the user.
- If the watchdog itself dies, the next `/assistant-loop` invocation respawns it. Until then, no supervision — in Docker the container restart policy still catches container-level failures.
- If a single cron fire fails (claude subprocess errors out), cron-daemon logs and continues with the schedule — one bad fire doesn't break future fires.
