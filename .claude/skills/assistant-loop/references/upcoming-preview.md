# Upcoming Preview (soft reminders)

> Run by the `upcoming-1h-preview` cron task (CRON.md), which fires every 20 min via a one-shot `claude -p`. Not part of the `/assistant-loop` REPL. Goal: ONE notification per event, ~15-30 min lead, never spam, respect quiet hours.

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
