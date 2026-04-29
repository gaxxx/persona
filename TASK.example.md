# TASK.md — Scheduled Tasks

Source of truth for recurring tasks. On every session startup, register each task below via `CronCreate`. Each task updates its own **Last run** line when it fires so you can tell from any future session when it last executed.

*Copy this file to `TASK.md` and edit. `TASK.md` is gitignored — add your real chat_id and task prompts there.*

## example-task

- **Cron:** `13,43 7-22 * * *` (every 30 min, 7am–11pm local)
- **Durable:** true
- **Purpose:** One-line summary of what this task does.
- **Last run:** never
- **Prompt:**

  ```
  Describe what should happen on each fire. If the task pushes to Telegram,
  use: `bun run bin/tg-send.ts <CHAT_ID> "<message>"`.

  Always end with: update TASK.md's "Last run" line for this task
  with the current ISO timestamp.
  ```

---

## How to register on session startup

For each task section above:

1. Read its **Cron**, **Durable**, and **Prompt** fields.
2. Call `CronCreate` with those values.
3. Don't duplicate — if `CronList` already shows a job with the same prompt, skip.
