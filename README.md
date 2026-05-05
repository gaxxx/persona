# persona

A personal Telegram-driven assistant powered by Claude Code.

You message a Telegram bot; an LLM with access to your knowledge base, calendar, email, and any custom skills you write replies in your voice and on your terms. Each user runs their own instance with their own bot, vault, and personal skills - no shared backend.

## What it does

- **Chat over Telegram.** Send a text, photo, document, or sticker; the assistant reads it, picks a skill or replies directly, and writes back.
- **Runs scheduled tasks.** A separate cron daemon reads `CRON.md` and fires prompts on schedule (daily journal, weekly review, mailbox digest, ...).
- **Talks to your knowledge base.** A pluggable `/kb` skill - you ship your own implementation against a tiny `put` / `query` / `lint` contract.
- **Composes with MCP.** Gmail, Google Calendar, Drive, and any other MCP server you wire up are just tools the assistant can pick.

## Architecture

Three independent processes talk to a shared filesystem and persona config:

- `bin/tg-daemon.ts` - long-running Telegram I/O. Owns a persistent `claude -p --input-format stream-json` subprocess that handles every message in the same session.
- `bin/cron-daemon.ts` - reads `CRON.md`, schedules each task by its cron expression, spawns a one-shot `claude -p` on fire. Auto-reloads on file change.
- `bin/watchdog.sh` - bash supervisor (no LLM). Polls every 60s, respawns either daemon if dead, and Telegram-alerts on respawn. Spawned by `/assistant-loop` and disowned, so it survives REPL exit.
- The interactive REPL you `claude` into - ad-hoc work and on-demand status checks via `/assistant-loop`.

Skills:
- `/setup` is a tracked slash command at `.claude/commands/setup.md`, so it works the moment you `git clone` - no bootstrap step needed. Nothing else lives under `.claude/` in the repo.
- The shipped skills (`assistant-loop`, `assistant-test`, `kb` interface stub) live as templates in `share/skills/`. `/setup` copies them into `<vault>/persona/.claude/skills/` and symlinks each back into `.claude/skills/`. After that, the vault owns those skills and you can edit them freely. Re-run `./bin/link-skills.sh` after pulling repo changes — it diffs vs your vault copy and asks before overwriting.
- Personal skills you author go straight into the vault.

## Setup

```bash
git clone <repo-url> persona && cd persona
claude                # then type:  /setup
```

`/setup` is an interactive wizard - it walks through `.env`, validates your Telegram bot token, sends a test message to your chat_id, provisions the vault skeleton, copies the starter `kb-impl`, and wires up `.claude/skills` as a symlink to the vault. Idempotent; safe to re-run.

After `/setup` finishes:

```bash
docker compose up -d --build                          # build + run; auto-starts /assistant-loop in tmux
docker compose exec persona tmux attach -t loop       # attach to the live loop (Ctrl-B D to detach)
```

The container's `CMD` runs `claude --dangerously-skip-permissions /assistant-loop` inside a tmux session named `loop`, which boots tg-daemon + cron-daemon and spawns the bash watchdog to keep them alive. Auth carries over from the host's `~/.claude` (mount); if you've never logged in, run `claude /login` on the host once first.

Common ops:

```bash
docker compose logs -f persona            # tail tmux's output without attaching
docker compose exec persona bash          # ad-hoc shell (don't open a second `claude`)
docker compose restart persona            # restart the loop
docker compose down                       # stop
```

See [SETUP.md](./SETUP.md) for the long version.

## Why a separate repo per user

The repo holds the harness; your vault holds you. Personal data (identity, preferences, the knowledge base itself) lives outside the tracked tree, so the same code can be cloned and personalized by anyone without leaking the previous owner's life into git history.

## Acknowledgments

Built with love, and dedicated to my wife - whose patience and care while we renovated our home reminded me what it looks like to build something thoughtfully, one decision at a time.
