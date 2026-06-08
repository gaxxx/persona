---
description: Run the Gmail unread digest once — the deterministic wrapper that the gmail-unread-digest cron uses. Useful for manual triggers, debugging, or testing dedup behavior.
---

# /gmail-digest

Trigger one run of `bin/gmail-digest.ts` and report the result.

The script is the implementation; this command is the manual entry point. It does:

- Search Gmail for unread mail received in the last 60 minutes (using `after:<unix>` to dodge Gmail's `m`=months trap).
- **CLASSIFY pass (haiku, headers only):** split each result into DROP (promo/auto) or KEEP (personal/work) from sender+subject — no body fetch.
- Filter KEEP against `data/gmail-notified.json` (skip already-digested message IDs) BEFORE the expensive analyze pass.
- **ANALYZE pass (sonnet, reads bodies of the new KEEP mail):** per email produce a gist + a one-line handling suggestion, and — only for time-sensitive mail (interview/appointment/deadline) — a *proposed* schedule entry. Schedule items are NOT auto-created (cron is non-interactive); they're listed for the user to confirm with "建日程".
- Mark DROP as read via `mcp__gmail__batch_modify_emails` (sub-`claude -p` call).
- Send the digest (gist + 💡 suggestion + 📅 proposals) to Telegram.
- Persist surfaced message IDs into `data/gmail-notified.json`.
- Update the `## gmail-unread-digest` Last-run line in `<vault>/persona/CRON.md`.

If the analyze pass fails, it degrades gracefully to a header-only digest so mail is never silently dropped.

## How to run

```bash
bun run bin/gmail-digest.ts
```

Output is a single JSON line: `{"ok":true,"sent":N,"dropped":M,"dedup_filtered":K}`.

Report that line back. If exit code is non-zero, also surface the stderr.
