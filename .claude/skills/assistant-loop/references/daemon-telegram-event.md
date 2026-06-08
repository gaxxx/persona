# Daemon — On Telegram Event

> Reference for the tg-daemon's inner `claude` subprocess. The `/assistant-loop` REPL does not execute this; the daemon's own PRIMING enforces it at runtime. Kept here as the contract documentation.

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
   - **First turn after subprocess spawn**: read today's conversation file. If <10K chars include all; otherwise summarize older days and keep today verbatim. Also read `data/scratchpad.md` (see step 3a).
   - **Subsequent turns**: do NOT re-read by default — your in-context memory of prior turns covers it. Re-read only when (a) the user references past events ("yesterday" / "earlier" / "我之前说过" / "上次"), (b) `reply_to.from_bot=true`, or (c) the event JSON contains an `external_writes_since_last_turn` field — that's the daemon telling you a cron task (or another process) wrote to the log between your turns; treat the field's content as already-read context, no Read needed (unless it ends with a TRUNCATED marker).
   - **Trivial messages** (greetings like "你好" / "thanks" / "👍", or USER.md-derivable questions like "我在哪个时区"): skip the log entirely, even on the first turn.
3a. **Discussion scratchpad** (`data/scratchpad.md`): multi-thread working-memory keeping the frame (criteria, candidates, exclusions, leaning) of each open discussion alive across subprocess rotations and topic switches. Full spec lives in the daemon PRIMING; the rules in brief:
   - **Structure**: `## Active` / `## Deferred` / `## Recently decided`. Each thread is `### thread: <slug>` with **Touched:**, **Constraints:** (⚠️ prefix for hard non-negotiables), **Candidates:**, **Status:**.
   - **Caps**: ≤8 threads total, ≤5 active, ~400 chars/thread, <5KB file. Recently-decided ages out after 24h → `data/decisions-log.md`.
   - **Load** on first turn after spawn alongside the conversation log.
   - **Re-read** on every multi-turn decision turn before composing reply. Honor ⚠️ lines — don't contradict your own constraints.
   - **Update** on frame-change turns only (new constraint / candidate / decision / deferral / new topic). Decisions move to `## Recently decided`; deferrals to `## Deferred`; new topics ADD a new thread (never overwrite).
   - Skip entirely for one-shot or trivial messages.
4. **If `attachment` set** - Read it via the Read tool (Read supports images and PDFs natively).
5. **If `reply_to` set** - Use as context for what the user is responding to. If `reply_to.from_bot` is true, find that earlier message in `data/conversations/` for full context. If the replied-to had an attachment, look in `data/attachments/<reply_to.message_id>.*`.
6. If onboarding not done (`USER.md` has "not set" fields) -> run onboarding flow.
7. **Check available skills and MCP tools.** Pick the best fit, or reply directly if none applies.
8. Send: `bun run bin/tg-send.ts <chat_id> "<response>"`
9. **Log outgoing** - append to today's conversation file.

The daemon **only** owns Telegram. It does NOT start a Monitor, does NOT call `bin/tg-pull.ts`, and does NOT register crons.
