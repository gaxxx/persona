---
description: Run the Gmail unread digest once — the deterministic wrapper that the gmail-unread-digest cron uses. Useful for manual triggers, debugging, or testing dedup behavior.
---

# /gmail-digest

Trigger one run of `bin/gmail-digest.ts` and report the result.

The script is the implementation; this command is the manual entry point. It does:

- Search Gmail for the latest 50 unread inbox emails (`is:unread in:inbox`, maxResults 50).
- **CLASSIFY pass (haiku, headers only):** split each result into DROP (promo/auto) or KEEP (personal/work) from sender+subject — no body fetch.
- Filter KEEP against `data/gmail-notified.json` (skip already-digested message IDs) BEFORE the expensive analyze pass.
- **ANALYZE pass (sonnet, reads bodies of the new KEEP mail):** per email produce a gist + a one-line handling suggestion, and — only for time-sensitive mail (interview/appointment/deadline) — a *proposed* schedule entry. Schedule items are NOT auto-created (cron is non-interactive); they're listed for the user to confirm with "建日程".
- Archive DROP via `mcp__gmail__batch_modify_emails` — removes INBOX + UNREAD so promos leave the inbox (recoverable from All Mail) — (sub-`claude -p` call). **Archiving is not silent:** the digest footer lists what was archived (sender + subject + a one-line 原因 tag) so a misclassification is visible. DROP is still judged from headers only — no body fetch.
- Send the digest (gist + 💡 suggestion + 📅 proposals + 🗑️ archived list) to Telegram. A digest is sent whenever there's KEEP mail **or** anything was archived.
- Persist surfaced message IDs into `data/gmail-notified.json`.
- Update the `## gmail-unread-digest` Last-run line in `<vault>/persona/CRON.md`.

If the analyze pass fails, it degrades gracefully to a header-only digest so mail is never silently dropped.

## How to run

```bash
bun run bin/gmail-digest.ts          # default: latest 50 unread
bun run bin/gmail-digest.ts 100      # bigger sweep when a backlog piled up
```

The count defaults to 50; pass `<N>` (or set `GMAIL_DIGEST_LIMIT=<N>`) to process more. The cron runs the no-arg form, so it uses 50.

Output is a single JSON line: `{"ok":true,"sent":N,"dropped":M,"dedup_filtered":K}`.

Report that line back. If exit code is non-zero, also surface the stderr.
