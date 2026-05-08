# CRON.md - Scheduled Tasks

Source of truth for recurring tasks. `bin/cron-daemon.ts` parses each `## <id>` section, schedules by its `Cron:` expression, and on fire spawns either `claude -p` (for `**Prompt:**` entries) or `sh -c` (for `**Shell:**` entries — no LLM, ~free). Auto-reloads on file change (fs.watch). cron-daemon stamps the `Last run` line itself using the script's final stdout line as a 1-line summary. Use `Shell:` for deterministic wrapper-script invocations; use `Prompt:` only when the LLM's judgment is needed (compose, classify, summarize). Tasks should NOT update CRON.md themselves.

*This is the example template. Setup copies it into `<vault>/persona/CRON.md` (the path `bin/cron-daemon.ts` reads via `$VAULT_PATH`). No repo-root copy needed — `CLAUDE.md` is the only file Claude Code auto-loads from cwd, and it's synced via `bin/pbackup.sh` / `pstore.sh`. Edit `<vault>/persona/CRON.md` directly.*

## example-task

- **Cron:** `13,43 7-22 * * *` (every 30 min, 7am-11pm local)
- **Durable:** true
- **Purpose:** One-line summary of what this task does.
- **Last run:** never
- **Prompt:**

  ```
  Describe what should happen on each fire. If the task pushes to Telegram,
  use: `bun run bin/tg-send.ts <CHAT_ID> "<message>"`.

  End by printing a terse 1-line summary of what happened to stdout
  (e.g. "sent: 2 events" or "silent — nothing pending"). The cron-daemon
  uses that line as the Last-run suffix in CRON.md. Don't edit CRON.md
  yourself.
  ```

---

## upcoming-1h-preview

- **Cron:** `*/20 * * * *` (every 20 min, all day)
- **Durable:** true
- **Purpose:** Soft heads-up — scan calendar + tasks.md for events starting in the next ~30 min and ping Telegram once per event. Default-on; remove this section if you don't want it.
- **Setup (optional):** Calendar fetching uses the Google Calendar API directly (no `claude -p`). Run `bun run bin/gauth-reauth.ts` once to grant `calendar.readonly` scope. Without it the script no-ops on the calendar side and only scans `tasks.md` — safe to leave enabled either way.
- **Last run:** never
- **Shell:**

  ```
  bun run bin/upcoming.ts
  ```

---

## How registration works

`bin/cron-daemon.ts` is a long-running process that owns scheduling:

1. On startup it parses `CRON.md`, finds each `## <id>` section, reads `Cron:` + (`Prompt:` or `Shell:`).
2. It computes the next fire time per cron expression and `setTimeout`s it.
3. On fire, it spawns either `claude -p --permission-mode bypassPermissions <prompt>` (for `Prompt:` entries) or `sh -c <command>` (for `Shell:` entries) with cwd=repo root and inherited env. The subprocess does the work and exits; cron-daemon logs to `data/cron.log` and reschedules.
4. On exit-0, the daemon updates the task's `- **Last run:**` line with the current timestamp + the subprocess's final stdout line (truncated to 200 chars) as a 1-line summary. Tasks should NOT edit CRON.md themselves; failed tasks (non-zero exit) leave Last run untouched so the gap is visible.
5. fs.watch on `CRON.md` triggers a 500ms-debounced reload — adding, removing, or editing a task takes effect without a restart. Last run lines (whether daemon-written or hand-set) are preserved across reloads (only `Cron:` + `Prompt:`/`Shell:` are read at schedule time).
6. To start: `nohup bun run bin/cron-daemon.ts > data/cron-daemon.log 2>&1 & disown` (or let `bin/watchdog.sh` — spawned by `/assistant-loop` — start/restart it).
