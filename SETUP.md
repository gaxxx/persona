# Setup - running persona on a fresh machine

A personal Telegram-driven assistant powered by Claude Code. Each user runs their own instance with their own bot, vault, and personal skills.

## Architecture (one paragraph)

Three independent processes talk to a shared filesystem + persona:

- **tg-daemon** (`bin/tg-daemon.ts`) - long-running Telegram I/O via an inner `claude -p --input-format stream-json` subprocess.
- **cron-daemon** (`bin/cron-daemon.ts`) - reads `TASK.md`, schedules each task by its cron expression, and on fire spawns a one-shot `claude -p` to handle the prompt. Auto-reloads `TASK.md` on change.
- **Main REPL** - the interactive Claude Code session you `claude` into; runs heartbeat checks on the two daemons and handles ad-hoc work.

Skills are split into two layers:
- **Generic** (this repo): `assistant-loop`, `assistant-test`, `kb` interface stub.
- **Personal** (your vault, symlinked into the repo): `kb-impl` (your knowledge-base implementation), plus anything else like `game-time`, `ds160`, etc.

## Prerequisites

- **Docker** (Desktop on macOS / Engine on Linux) - or run natively with Bun + a globally-installed `@anthropic-ai/claude-code`
- **A Telegram bot** - talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token
- **Your Telegram chat_id** - message [@userinfobot](https://t.me/userinfobot)
- **An Obsidian vault** (or any folder you'll treat as one) - kb data lives here

## One-time setup

```bash
git clone <repo-url> persona
cd persona

# 1. Project config
cp .env.example .env
# edit .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, VAULT_PATH, TZ
# (quote VAULT_PATH if it has spaces)

cp CLAUDE.example.md CLAUDE.md
# CLAUDE.md is gitignored - tweak personality/style if you want

# 2. Vault skeleton + kb implementation
mkdir -p "$VAULT_PATH"/{persona,raw}
# Leave persona/ empty - first Telegram message triggers onboarding,
# which creates IDENTITY.md and USER.md interactively.

# Pick a kb implementation (or write your own):
cp -r .claude/skills/kb/examples/minimal "$VAULT_PATH/persona/skills/kb-impl"
# This is a flat-folder starter. Read it, customize, or replace with PARA / Logseq / etc.

# 3. Link personal skills from your vault into the repo
./bin/link-personal-skills.sh

# 4. Add scheduled tasks (optional)
cp TASK.example.md TASK.md
# Edit task sections; cron-daemon reads this file and auto-reloads on save.

# 5. Build and start
docker compose up -d --build
```

## Personal vs generic skills

| Layer | Lives in | Examples | Tracked? |
|---|---|---|---|
| Generic infra | this repo | `bin/{tg,cron}-daemon.ts`, `.env.example`, Dockerfile, SETUP.md | yes |
| Generic skills | `repo/.claude/skills/` | `assistant-loop`, `assistant-test`, `kb` (interface stub) | yes |
| Personal config | repo (gitignored) | `.env`, `CLAUDE.md`, `TASK.md` | no |
| Personal skills | `<vault>/persona/skills/` | `kb-impl`, `game-time`, `ds160`, ... | no (vault is yours) |

`bin/link-personal-skills.sh` symlinks every `<vault>/persona/skills/*` into the repo's `.claude/skills/` so Claude Code sees both layers as if they were local. Idempotent - re-run any time you add a vault skill.

To add a new personal skill:
```bash
mkdir -p "$VAULT_PATH/persona/skills/<name>"
# author SKILL.md and references/
./bin/link-personal-skills.sh   # re-link
```

## kb interface vs implementation

The `/kb` skill in this repo is a thin **interface** - it documents the contract (`put`, `query`, `lint` are required; `ingest` / `plan` / `clip` / etc. are implementation-defined) but does not actually store anything. The real storage logic lives in your vault at `<vault>/persona/skills/kb-impl/`.

This decouples callers from layout choices. Other skills should call `/kb put <file>` and use the returned path; never hard-code paths. Different users can plug in PARA + Obsidian, Logseq, or plain folders without touching repo code.

A minimal flat-folder example implementation ships at `.claude/skills/kb/examples/minimal/` - copy it as a starting point.

## Authenticating Claude Code

The compose file mounts `~/.claude` from the host so a Claude Code subscription session carries through. If you've never logged in:

```bash
docker compose exec persona claude
# inside the container, run /login and follow the OAuth prompt
```

Then start the assistant loop:

```bash
docker compose exec persona claude /assistant-loop
```

## First Telegram message

Send any message to your bot. The assistant will:
1. Notice `USER.md` is empty -> run onboarding (asks for name, timezone, language)
2. Pick its own identity (`IDENTITY.md`)
3. Reply

After onboarding, any scheduled tasks in `TASK.md` start running on the cron-daemon's schedule.

## Adding scheduled tasks

`TASK.md` is the source of truth for cron tasks. Each `## <task-id>` section has a `Cron:` expression and a `Prompt:` block. The cron-daemon parses this file on startup and reloads on change (fs.watch). On fire it spawns a fresh `claude -p --permission-mode bypassPermissions <prompt>` subprocess; the prompt itself does the work and writes results (typically to Telegram via `bin/tg-send.ts`).

Each task is expected to update its own `**Last run:**` line when it fires.

## File layout

```
repo/
├── bin/
│   ├── tg-daemon.ts            # Telegram I/O daemon
│   ├── tg-send.ts / tg-typing.ts / tg-pull.ts / tg-watch.ts
│   ├── cron-daemon.ts          # scheduled-task daemon
│   └── link-personal-skills.sh # symlink helper
├── .claude/skills/
│   ├── assistant-loop/         # generic
│   ├── assistant-test/         # generic
│   ├── kb/                     # interface stub (generic)
│   │   └── examples/minimal/   # starter kb-impl
│   ├── kb-impl@                # symlink to <vault>
│   ├── ds160@ game-time@ ...   # other personal skills (symlinks)
├── .env                        # per-user secrets (gitignored)
├── CLAUDE.md                   # per-user instructions (gitignored)
├── TASK.md                     # per-user cron tasks (gitignored)
└── docker-compose.yml

<vault>/
├── persona/
│   ├── IDENTITY.md / USER.md / MEMORY.md / tasks.md
│   ├── tests/cases.md          # /assistant-test cases
│   └── skills/                 # personal skills (kb-impl, game-time, ...)
├── raw/                        # /kb ingest inbox
└── kb/ ...                     # whatever your kb-impl writes
```

## Stopping / restarting

```bash
docker compose stop                           # stop without removing
docker compose down                           # stop and remove container
docker compose up -d                          # start in background
docker compose logs -f                        # tail logs
docker compose exec persona claude /assistant-loop  # attach Claude Code inside
```

## Troubleshooting

- **Bot replies once and stops** - Telegram's `getUpdates` is single-connection. Make sure you don't have a host process holding the bot token while the container also runs.
- **Cron tasks don't fire on time** - check `data/cron-daemon.log`. Common cause: laptop slept past the scheduled minute. cron-daemon will fire on the next match after wake; sleep is a hard limit.
- **Cron tasks rejected with "TELEGRAM_CHAT_ID not set"** - bin scripts enforce a chat allowlist; ensure `.env` has `TELEGRAM_CHAT_ID=<your-id>` (or `TELEGRAM_CHAT_IDS=id1,id2` for multi-user).
- **Vault writes don't show up in Obsidian** - Google Drive bind-mounts on macOS sometimes lag a few seconds. Force-sync the Drive client or wait.
- **MCP OAuth errors** - claude.ai connectors (Gmail, Calendar, Notion) re-auth via `~/.claude/`. Run `claude` interactively to refresh the session.
- **`/kb <subcmd>` says "implementation not installed"** - run `cp -r .claude/skills/kb/examples/minimal "$VAULT_PATH/persona/skills/kb-impl"` then `./bin/link-personal-skills.sh`.
