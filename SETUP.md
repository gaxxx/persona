# Setup - running persona on a fresh machine

A personal Telegram-driven assistant powered by Claude Code. Each user runs their own instance with their own bot, vault, and personal skills.

## Architecture (one paragraph)

Three independent processes talk to a shared filesystem + persona:

- **tg-daemon** (`bin/tg-daemon.ts`) - long-running Telegram I/O via an inner `claude -p --input-format stream-json` subprocess.
- **cron-daemon** (`bin/cron-daemon.ts`) - reads `CRON.md`, schedules each task by its cron expression, and on fire spawns a one-shot `claude -p` to handle the prompt. Auto-reloads `CRON.md` on change.
- **Watchdog** (`bin/watchdog.sh`) - bash supervisor that polls every 60s and respawns either daemon if it dies. Spawned by `/assistant-loop` and disowned.
- **Main REPL** - the interactive Claude Code session you `claude` into; handles ad-hoc work. Runs `/assistant-loop` once on entry to (re)spawn the watchdog if needed and check daemon status; no background heartbeat.

Skills are split into two layers:
- **Shared** (committed in this repo at `.claude/skills/`): `assistant-loop`, `assistant-test`, `kb` interface stub, `onboarding`. Tracked by git per `.gitignore` exception list.
- **Personal** (gitignored): `kb-impl` (your knowledge-base implementation), plus anything else like `game-time`, `ds160`, etc. They live as real directories under `.claude/skills/<name>/` in the repo, and are mirrored to `<vault>/persona/.claude/skills/` via `bin/pbackup.sh` / `bin/pstore.sh` (a `Stop` hook auto-pushes after every Claude Code session).

## Prerequisites

- **Docker** (Desktop on macOS / Engine on Linux) - or run natively with Bun + a globally-installed `@anthropic-ai/claude-code`
- **A Telegram bot** - talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token
- **Your Telegram chat_id** - message [@userinfobot](https://t.me/userinfobot)
- **An Obsidian vault** (or any folder you'll treat as one) - kb data lives here

## One-time setup

The fastest path is `./setup.sh`, which wraps every step below into one interactive flow:

```bash
git clone <repo-url> persona && cd persona
./setup.sh
```

`setup.sh` picks your language, validates your Telegram token (calls `getMe`), sends a test message to your `chat_id`, writes `.env`, copies `CLAUDE.md` and `STRUCTURE.md` from examples, provisions `<vault>/persona/`, offers the minimal `kb-impl` starter, and asks whether to deploy via Docker or natively. Idempotent — safe to re-run when you switch vaults or rotate tokens.

If you'd rather do it by hand, the same steps:

```bash
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
cp -r .claude/skills/kb/examples/minimal "$VAULT_PATH/persona/.claude/skills/kb-impl"
# This is a flat-folder starter. Read it, customize, or replace with PARA / Logseq / etc.

# 3. Sync personal files (CLAUDE.md, personal skills) between repo and vault
bash bin/pstore.sh   # vault -> repo  (after fresh clone)
# bash bin/pbackup.sh  # repo -> vault (after edits; Stop hook does this automatically)

# 4. Add scheduled tasks (optional)
cp CRON.example.md "$VAULT_PATH/persona/CRON.md"
# Edit task sections; cron-daemon reads $VAULT_PATH/persona/CRON.md and auto-reloads on save.
```

Then:

```bash
# 5. Build and start (Dockerfile CMD auto-runs `claude /assistant-loop` inside tmux)
docker compose up -d --build
docker compose exec persona tmux attach -t loop   # attach (Ctrl-B D to detach)
```

**Note on `VAULT_PATH`** — the variable serves two roles. On the host, `${VAULT_PATH}` from `.env` is the bind-mount source (e.g. `/volume1/.../Obsidian`). Inside the container, the vault is always at `/vault`, so `docker-compose.yml` explicitly re-exports `VAULT_PATH=/vault` in the `environment:` block to override what `env_file: .env` would otherwise inject. If you remove that line, the daemons will look for `<vault>/persona/CRON.md` at the host path and fail to start.

## Personal vs generic skills

| Layer | Lives in | Examples | Tracked? |
|---|---|---|---|
| Generic infra | this repo | `bin/{tg,cron}-daemon.ts`, `.env.example`, Dockerfile, SETUP.md | yes |
| Shared skills | `.claude/skills/<name>/` | `assistant-loop`, `assistant-test`, `kb` (interface stub), `onboarding` | yes (per `.gitignore` exceptions) |
| Personal config (repo, gitignored) | repo root | `.env`, `CLAUDE.md`, `CLAUDE.local.md` | no |
| Personal config (vault) | `<vault>/persona/` | `CLAUDE.md`, `CRON.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `tasks.md` | yes (vault is yours) |
| Personal skills (repo, gitignored) | `.claude/skills/<name>/` | `kb-impl`, plus anything you write | no |
| Personal skills (vault backup) | `<vault>/persona/.claude/skills/<name>/` | mirror of above | yes (vault is yours) |

`setup.sh` lives at the repo root, so it works the moment you `git clone`. Shared skills are committed directly into `.claude/skills/` (per `.gitignore` exception list) and need no install step. Personal skills + `CLAUDE.md` (+ optional `CLAUDE.local.md`) are gitignored real files synced with the vault via `bin/pbackup.sh` / `bin/pstore.sh`:

- **`pstore`** copies `<vault>/persona/CLAUDE.md` and personal-skill dirs INTO the repo. Run after a fresh clone or when restoring local state.
- **`pbackup`** copies the same files OUT of the repo into the vault. A `Stop` hook in `.claude/settings.local.json` runs this automatically after every Claude Code session.

Vault is canonical; on drift, `pstore` wins.

## kb interface vs implementation

The `/kb` skill in this repo is a thin **interface** - it documents the contract (`put`, `query`, `lint` are required; `ingest` / `plan` / `clip` / etc. are implementation-defined) but does not actually store anything. The real storage logic lives in your vault at `<vault>/persona/.claude/skills/kb-impl/`.

This decouples callers from layout choices. Other skills should call `/kb put <file>` and use the returned path; never hard-code paths. Different users can plug in PARA + Obsidian, Logseq, or plain folders without touching repo code.

A minimal flat-folder example implementation ships at `.claude/skills/kb/examples/minimal/` - copy it as a starting point.

## Authenticating Claude Code

Claude Code auth lives inside the container (no host `~/.claude` mount — auth is per-container). The container's `CMD` runs `claude /assistant-loop` inside a tmux session named `loop`; on first boot, Claude Code shows its login prompt there and waits. Attach to finish login:

```bash
docker compose exec persona tmux a -t loop   # Ctrl-B D to detach
```

Once logged in, the same session proceeds into `/assistant-loop` automatically. Credentials persist as long as the container's filesystem layer survives. `docker compose down -v` or rebuilding the image wipes them; re-attach to log in again.

For routine ad-hoc shell work inside the running container, use `docker compose exec persona bash` — opening a second `claude` session shares the credentials with the main loop and one stray `/logout` will deauth both.

## First Telegram message

Send any message to your bot. The assistant will:
1. Notice `USER.md` is empty -> run onboarding (asks for name, timezone, language)
2. Pick its own identity (`IDENTITY.md`)
3. Reply

After onboarding, any scheduled tasks in `<vault>/persona/CRON.md` start running on the cron-daemon's schedule.

## Adding scheduled tasks

`<vault>/persona/CRON.md` is the source of truth for cron tasks. Each `## <task-id>` section has a `Cron:` expression and a `Prompt:` block. The cron-daemon resolves the path from `$VAULT_PATH/persona/CRON.md`, parses it on startup, and reloads on change (fs.watch). On fire it spawns a fresh `claude -p --permission-mode bypassPermissions <prompt>` subprocess; the prompt itself does the work and writes results (typically to Telegram via `bin/tg-send.ts`).

Each task is expected to update its own `**Last run:**` line when it fires.

## File layout

```
repo/
├── bin/
│   ├── tg-daemon.ts            # Telegram I/O daemon
│   ├── tg-send.ts / tg-typing.ts
│   ├── cron-daemon.ts          # scheduled-task daemon
│   ├── watchdog.sh             # bash supervisor
│   ├── pbackup.sh / pstore.sh  # sync personal files (CLAUDE.md + personal skills) with vault
│   └── ...
├── .claude/
│   ├── commands/                # tracked Claude Code slash commands (if any)
│   ├── settings.local.json     # personal hooks/permissions (gitignored)
│   └── skills/
│       ├── assistant-loop/     # tracked (per .gitignore exceptions)
│       ├── assistant-test/     # tracked
│       ├── kb/                 # tracked - interface stub + examples/minimal/
│       ├── onboarding/         # tracked
│       └── <personal>/         # gitignored - mirrored to vault via pbackup
├── .env                        # per-user secrets (gitignored)
├── CLAUDE.md                   # gitignored real file; synced with vault via pbackup
├── CLAUDE.local.md             # optional personal overrides (gitignored)
└── docker-compose.yml

<vault>/                        # default ./Obsidian inside the repo (gitignored)
├── STRUCTURE.md                # canonical map of vault layout
├── persona/
│   ├── CLAUDE.md / CRON.md     # CRON.md is read directly via $VAULT_PATH; CLAUDE.md mirrors repo copy
│   ├── IDENTITY.md / USER.md / MEMORY.md / tasks.md
│   └── .claude/skills/<name>/  # backup copies of personal skills (pbackup target)
├── raw/                        # /kb ingest inbox
└── kb/                         # whatever your kb-impl writes
```

## Stopping / restarting

```bash
docker compose stop                                # stop without removing
docker compose down                                # stop and remove container
docker compose up -d                               # start in background (auto-runs assistant-loop in tmux)
docker compose restart persona                     # restart the loop
docker compose logs -f persona                     # tail tmux output
docker compose exec persona tmux attach -t loop    # attach to the live loop (Ctrl-B D to detach)
docker compose exec persona bash                   # ad-hoc shell (don't open another `claude`)
```

## Troubleshooting

- **Bot replies once and stops** - Telegram's `getUpdates` is single-connection. Make sure you don't have a host process holding the bot token while the container also runs.
- **`cron-daemon: failed to read /<host-path>/persona/CRON.md`** - `docker-compose.yml` is missing the `VAULT_PATH=/vault` override in `environment:`. The host-side `VAULT_PATH` is leaking into the container via `env_file`. Add the override back and `docker compose up -d --force-recreate`.
- **Cron tasks don't fire on time** - check `data/cron-daemon.log`. Common cause: laptop slept past the scheduled minute. cron-daemon will fire on the next match after wake; sleep is a hard limit.
- **Cron tasks rejected with "TELEGRAM_CHAT_ID not set"** - bin scripts enforce a chat allowlist; ensure `.env` has `TELEGRAM_CHAT_ID=<your-id>` (or `TELEGRAM_CHAT_IDS=id1,id2` for multi-user).
- **Vault writes don't show up in Obsidian** - Google Drive bind-mounts on macOS sometimes lag a few seconds. Force-sync the Drive client or wait.
- **MCP OAuth errors** - claude.ai connectors (Gmail, Calendar, Notion) re-auth via the container's `~/.claude/`. Run `docker compose exec persona claude` interactively to refresh the session.
- **`/kb <subcmd>` says "implementation not installed"** - run `cp -r .claude/skills/kb/examples/minimal "$VAULT_PATH/persona/.claude/skills/kb-impl"`, then `bash bin/pstore.sh` to mirror it back into the repo.
