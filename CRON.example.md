# CRON.md - Scheduled Tasks

Source of truth for recurring tasks. The `bin/cron-daemon.ts` process reads this file, schedules each section by its `Cron:` expression, and on fire spawns a one-shot `claude -p --permission-mode bypassPermissions` to execute the prompt. Auto-reloads on file change (fs.watch). Each task self-updates its own **Last run** line when it fires.

*This is the example template. Setup copies it into `<vault>/persona/CRON.md` and symlinks the result back into the repo as `CRON.md` (gitignored). Edit the vault copy — add your real chat_id and task prompts there.*

## example-task

- **Cron:** `13,43 7-22 * * *` (every 30 min, 7am-11pm local)
- **Durable:** true
- **Purpose:** One-line summary of what this task does.
- **Last run:** never
- **Prompt:**

  ```
  Describe what should happen on each fire. If the task pushes to Telegram,
  use: `bun run bin/tg-send.ts <CHAT_ID> "<message>"`.

  Always end with: update CRON.md's "Last run" line for this task
  with the current ISO timestamp.
  ```

---

## How registration works

`bin/cron-daemon.ts` is a long-running process that owns scheduling:

1. On startup it parses `CRON.md`, finds each `## <id>` section, reads `Cron:` + `Prompt:`.
2. It computes the next fire time per cron expression and `setTimeout`s it.
3. On fire, it spawns `claude -p --permission-mode bypassPermissions <prompt>` with cwd=repo root and inherited env. The subprocess does the work and exits; cron-daemon logs to `data/cron.log` and reschedules.
4. fs.watch on `CRON.md` triggers a 500ms-debounced reload - adding, removing, or editing a task takes effect without a restart. The "Last run" line each task writes back is preserved across reloads.
5. To start: `nohup bun run bin/cron-daemon.ts > data/cron-daemon.log 2>&1 & disown` (or rely on `assistant-loop`'s heartbeat to start/restart it).
