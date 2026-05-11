# Contributing

Thanks for taking a look. A few notes before you open an issue or PR.

## Project scope

`persona` is a **personal scaffold**, not a product. The repo holds the harness (Telegram I/O, cron, watchdog, skill loader, kb interface stub); your data, identity, and most skills live in your own vault outside git. That shape is intentional and won't change.

What this means in practice:

- **In scope**: bug fixes, doc fixes, infra improvements that all users benefit from (better cron scheduling, more robust daemon supervision, cleaner setup flow, additional shared skills with broad appeal).
- **Out of scope**: features tied to a specific kb implementation, calendar provider, language, or personal workflow. Those belong in *your* `kb-impl/` or personal skills, not upstream.
- **Maybe** (open an issue first): a new shared skill or MCP integration. If it's genuinely generic and well-bounded, happy to discuss. If it's "useful to me," fork and keep it personal.

## Filing a bug

1. Reproduce on a clean clone if you can (`./setup.sh` into a tmp dir).
2. Open an issue with: what you ran, what you expected, what happened, and which daemon logs say (`data/tg-daemon.log`, `data/cron-daemon.log`, `data/cron.log`).
3. Redact tokens. The Telegram bot token and any MCP `Authorization` headers are the obvious ones.

## Sending a PR

1. One topic per PR. Keep the diff scannable.
2. Don't commit `.env`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, anything under `data/`, or anything under your vault. The `.gitignore` should catch these; double-check with `git status` before pushing.
3. If you touch a shipped skill (`.claude/skills/{assistant-loop,assistant-test,kb,onboarding}`), make sure your change still makes sense for users whose vault layout differs from yours.
4. No need to update CHANGELOG / version — there isn't one.

## Security

Found a token leak, RCE-ish behavior, or a way for an inbound Telegram message to do something it shouldn't? Please email instead of opening a public issue. Contact in the repo profile.
