# Setup - running persona on a fresh machine

A personal Telegram-driven assistant powered by Claude Code. Each user runs their own instance with their own bot, vault, and identity files.

## Prerequisites

- **Docker** (Desktop on macOS / Engine on Linux)
- **A Telegram bot** - talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token
- **Your Telegram chat_id** - message [@userinfobot](https://t.me/userinfobot)
- **An Obsidian vault** - any folder works; the assistant will create `persona/` and `kb/` inside it on first run

## One-time setup

```bash
git clone <repo-url> persona
cd persona

# 1. Project config
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VAULT_PATH, TZ

cp CLAUDE.example.md CLAUDE.md
# CLAUDE.md is gitignored - tweak the personality/style if you want

# 2. Vault skeleton (if your vault is brand new)
mkdir -p "$(grep ^VAULT_PATH .env | cut -d= -f2)/persona"
# Leave persona/ empty - first Telegram message triggers onboarding,
# which creates IDENTITY.md and USER.md interactively.

# 3. Build and start
docker compose up -d --build
```

## Authenticating Claude Code

The compose file mounts `~/.claude` from the host so a Claude Code subscription session carries through. If you've never logged in:

```bash
docker compose exec persona claude
# inside the container, run /login and follow the OAuth prompt
```

Re-run after logging in:

```bash
docker compose exec persona claude /assistant-loop
```

## First Telegram message

Send any message to your bot. The assistant will:
1. Notice `USER.md` is empty -> run onboarding (asks for name, timezone, language)
2. Pick its own identity (`IDENTITY.md`)
3. Reply

After onboarding, scheduled tasks (if you set up `TASK.md`) start running on cron.

## Adding scheduled tasks

```bash
cp TASK.example.md TASK.md
# Edit each task section: cron schedule, durable, prompt
# `TASK.md` is gitignored - your tasks are private.
```

The next time `/assistant-loop` starts, it reads `TASK.md` and registers each task via `CronCreate`. Each task self-updates its **Last run** line when it fires.

## File layout

| Path | Purpose |
|------|---------|
| `bin/` | Telegram I/O scripts (`tg-send`, `tg-pull`, `tg-watch`, `tg-daemon`) |
| `.claude/skills/assistant-loop/` | Telegram I/O loop (generic) |
| `.claude/skills/assistant-test/` | Routing/quality test runner |
| `CLAUDE.md` | Per-user assistant instructions (gitignored) |
| `TASK.md` | Per-user scheduled cron tasks (gitignored) |
| `.env` | Per-user secrets (gitignored) |
| `<vault>/persona/IDENTITY.md` | Assistant's personality |
| `<vault>/persona/USER.md` | Your profile |
| `<vault>/persona/MEMORY.md` | Things the assistant should remember |
| `<vault>/persona/tasks.md` | Obsidian Tasks (todos, reminders) |
| `<vault>/persona/tests/cases.md` | `/assistant-test` test cases |

## Stopping / restarting

```bash
docker compose stop          # stop without removing
docker compose down          # stop and remove container
docker compose up -d         # start in background
docker compose logs -f       # tail logs
docker compose exec persona claude /assistant-loop   # attach a Claude Code session inside
```

## Adding your own skills

Drop a folder under `.claude/skills/<name>/` with a `SKILL.md`. Skills containing personal data (e.g. `kb`, `game-time`) should be gitignored - see `.gitignore` for the pattern.

## Troubleshooting

- **Bot replies once and stops** - Telegram's `getUpdates` is single-connection. Make sure you don't have a host process holding the bot token at the same time as the container.
- **Cron tasks don't fire** - the assistant must be in `/assistant-loop` mode (not idle). Check `docker compose logs persona`.
- **Vault writes don't show up in Obsidian** - Google Drive bind-mounts on macOS sometimes lag a few seconds. Force-sync the Drive client or wait.
- **MCP OAuth errors** - claude.ai connectors (Gmail, Calendar, Notion) re-auth via `~/.claude/`. Run `claude` interactively to refresh the session.
