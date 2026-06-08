# How cron tasks run (background)

> Background mechanics for how cron-daemon executes CRON.md tasks. Reference only — the `/assistant-loop` REPL does not see cron fires.

The main REPL does NOT see cron fires — they run in independent processes spawned by cron-daemon. Each cron entry in `CRON.md`:

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
