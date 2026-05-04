# CRON.md - Scheduled Tasks

Source of truth for recurring tasks. The `bin/cron-daemon.ts` process reads this file, schedules each section by its `Cron:` expression, and on fire spawns a one-shot `claude -p --permission-mode bypassPermissions` to execute the prompt. Auto-reloads on file change (fs.watch). On successful task completion (exit 0), the daemon updates the task's **Last run** line with the current timestamp + the task's final stdout line as a 1-line summary — tasks should NOT update CRON.md themselves; just print a terse summary as their last line.

*This is the example template. Setup copies it into `<vault>/persona/CRON.md` (the path `bin/cron-daemon.ts` reads via `$VAULT_PATH`). No repo-root copy or symlink — only `CLAUDE.md` needs that, since Claude Code auto-loads it from cwd. Edit `<vault>/persona/CRON.md` directly.*

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
- **Last run:** never
- **Prompt:**

  ```
  Upcoming preview (scheduled, task id: upcoming-1h-preview).
  Run the procedure in assistant-loop SKILL.md § Upcoming Preview. End
  by printing a 1-line summary to stdout (e.g. "2 events" or "silent");
  the cron-daemon stamps Last-run with that summary.
  ```

---

## How registration works

`bin/cron-daemon.ts` is a long-running process that owns scheduling:

1. On startup it parses `CRON.md`, finds each `## <id>` section, reads `Cron:` + `Prompt:`.
2. It computes the next fire time per cron expression and `setTimeout`s it.
3. On fire, it spawns `claude -p --permission-mode bypassPermissions <prompt>` with cwd=repo root and inherited env. The subprocess does the work and exits; cron-daemon logs to `data/cron.log` and reschedules.
4. On exit-0, the daemon updates the task's `- **Last run:**` line with the current timestamp + the subprocess's final stdout line (truncated to 200 chars) as a 1-line summary. Tasks should NOT edit CRON.md themselves; failed tasks (non-zero exit) leave Last run untouched so the gap is visible.
5. fs.watch on `CRON.md` triggers a 500ms-debounced reload — adding, removing, or editing a task takes effect without a restart. Last run lines (whether daemon-written or hand-set) are preserved across reloads (only `Cron:` and `Prompt:` are read at schedule time).
6. To start: `nohup bun run bin/cron-daemon.ts > data/cron-daemon.log 2>&1 & disown` (or rely on `assistant-loop`'s heartbeat to start/restart it).
