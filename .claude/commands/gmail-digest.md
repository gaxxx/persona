---
description: Run the Gmail unread digest once — the deterministic wrapper that the gmail-unread-digest cron uses. Useful for manual triggers, debugging, or testing dedup behavior.
---

# /gmail-digest

Trigger one run of `bin/gmail-digest.ts` and report the result.

The script is the implementation; this command is the manual entry point. It does:

- Search Gmail for unread mail received in the last 60 minutes (using `after:<unix>` to dodge Gmail's `m`=months trap).
- Classify each result as DROP (promo/auto) or KEEP (personal/work) via a sub-`claude -p` call.
- Filter KEEP against `data/gmail-notified.json` (skip already-digested message IDs).
- Mark DROP as read via `mcp__gmail__batch_modify_emails` (sub-`claude -p` call).
- Send the KEEP digest to Telegram via `bin/tg-send.ts`.
- Persist sent message IDs into `data/gmail-notified.json`.
- Update the `## gmail-unread-digest` Last-run line in `<vault>/persona/CRON.md`.

## How to run

```bash
bun run bin/gmail-digest.ts
```

Output is a single JSON line: `{"ok":true,"sent":N,"dropped":M,"dedup_filtered":K}`.

Report that line back. If exit code is non-zero, also surface the stderr.
