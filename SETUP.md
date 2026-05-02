# Setup - running persona on a fresh machine

A personal Telegram-driven assistant powered by Claude Code. Each user runs their own instance with their own bot, vault, and personal skills.

## Architecture (one paragraph)

Three independent processes talk to a shared filesystem + persona:

- **tg-daemon** (`bin/tg-daemon.ts`) - long-running Telegram I/O via an inner `claude -p --input-format stream-json` subprocess.
- **cron-daemon** (`bin/cron-daemon.ts`) - reads `CRON.md`, schedules each task by its cron expression, and on fire spawns a one-shot `claude -p` to handle the prompt. Auto-reloads `CRON.md` on change.
- **Main REPL** - the interactive Claude Code session you `claude` into; runs heartbeat checks on the two daemons and handles ad-hoc work.

Skills are split into two layers:
- **Generic** (this repo): `assistant-loop`, `assistant-test`, `kb` interface stub.
- **Personal** (your vault): `kb-impl` (your knowledge-base implementation), plus anything else like `game-time`, `ds160`, etc. The vault dir is exposed to the repo via a single `.claude/skills` symlink.

## Prerequisites

- **Docker** (Desktop on macOS / Engine on Linux) - or run natively with Bun + a globally-installed `@anthropic-ai/claude-code`
- **A Telegram bot** - talk to [@BotFather](https://t.me/BotFather), `/newbot`, save the token
- **Your Telegram chat_id** - message [@userinfobot](https://t.me/userinfobot)
- **An Obsidian vault** (or any folder you'll treat as one) - kb data lives here

## One-time setup

The fastest path is the `/setup` skill, which wraps every step below into one interactive flow:

```bash
git clone <repo-url> persona && cd persona
claude                # then type:  /setup
```

`/setup` validates your Telegram token (calls `getMe`), sends a test message to your `chat_id`, writes `.env`, copies `CLAUDE.md` from the example, provisions `<vault>/persona/`, copies the minimal `kb-impl` starter, and runs `bin/link-skills.sh`. Idempotent - safe to re-run when you switch vaults or rotate tokens.

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
cp -r share/skills/kb/examples/minimal "$VAULT_PATH/persona/.claude/skills/kb-impl"
# This is a flat-folder starter. Read it, customize, or replace with PARA / Logseq / etc.

# 3. Install shared skills into your vault and symlink them back
./bin/link-skills.sh

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

## Personal vs generic skills

| Layer | Lives in | Examples | Tracked? |
|---|---|---|---|
| Generic infra | this repo | `bin/{tg,cron}-daemon.ts`, `.env.example`, Dockerfile, SETUP.md | yes |
| Generic skills | `repo/share/skills/` | `assistant-loop`, `assistant-test`, `kb` (interface stub), `setup` | yes |
| Personal config (repo, gitignored) | repo root | `.env`, `CLAUDE.md` (symlink to vault) | no |
| Personal config (vault) | `<vault>/persona/` | `CLAUDE.md`, `CRON.md`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `tasks.md` | yes (vault is yours) |
| Personal skills | `<vault>/persona/.claude/skills/` | `kb-impl`, plus anything you write | no (vault is yours) |

`/setup` ships as a tracked slash command at `.claude/commands/setup.md`, so it works the moment you `git clone` (no symlinks required yet). Nothing else under `.claude/` is tracked. `bin/link-skills.sh` manages the shared skills (`assistant-loop`, `assistant-test`, `kb`):

1. **Copies** each template from `share/skills/` into `<vault>/persona/.claude/skills/` as a real dir. Your vault becomes the working copy - edit freely.
2. **Symlinks** that vault copy back into `.claude/skills/<name>`.
3. Every subsequent run diffs each shared skill against `share/skills/` and asks y/N before overwriting if they differ; in-sync skills stay quiet.

Personal skills are yours to manage. The simplest path is to create them directly in `.claude/skills/<name>/` — `.gitignore` excludes everything under `.claude/skills/`, so they stay out of git automatically. If you want a personal skill backed up via your Obsidian vault, write it in `<vault>/persona/.claude/skills/<name>/` and symlink it yourself: `ln -s "$VAULT_PATH/persona/.claude/skills/<name>" .claude/skills/<name>`.

## kb interface vs implementation

The `/kb` skill in this repo is a thin **interface** - it documents the contract (`put`, `query`, `lint` are required; `ingest` / `plan` / `clip` / etc. are implementation-defined) but does not actually store anything. The real storage logic lives in your vault at `<vault>/persona/.claude/skills/kb-impl/`.

This decouples callers from layout choices. Other skills should call `/kb put <file>` and use the returned path; never hard-code paths. Different users can plug in PARA + Obsidian, Logseq, or plain folders without touching repo code.

A minimal flat-folder example implementation ships at `share/skills/kb/examples/minimal/` - copy it as a starting point.

## Authenticating Claude Code

The compose file mounts `~/.claude` from the host so a Claude Code subscription session carries through. If you've never logged in, do it on the **host** before `docker compose up`:

```bash
claude /login                               # on the host - writes ~/.claude/.credentials.json
```

Then `docker compose up -d --build` will pick up the credentials via the mount and the auto-run `claude /assistant-loop` will boot cleanly.

Don't open a second `claude` session inside the running container (`docker compose exec persona claude`) for routine work — it shares `~/.claude/.credentials.json` with the main loop and one stray `/logout` will deauth both. For ad-hoc shell work, use `docker compose exec persona bash`.

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
│   ├── tg-send.ts / tg-typing.ts / tg-pull.ts / tg-watch.ts
│   ├── cron-daemon.ts          # scheduled-task daemon
│   └── link-skills.sh          # wires up .claude/skills as a symlink
├── .claude/commands/setup.md   # tracked - /setup slash command bootstrap
├── share/skills/               # generic templates copied into vault on /setup
│   ├── assistant-loop/
│   ├── assistant-test/
│   └── kb/                     # interface stub
│       └── examples/minimal/   # starter kb-impl
├── .claude/skills/             # all entries are symlinks to vault (gitignored)
│   └── <name>@                 # populated by bin/link-skills.sh
├── .env                        # per-user secrets (gitignored)
├── CLAUDE.md@                  # symlink -> <vault>/persona/CLAUDE.md (gitignored)
└── docker-compose.yml

<vault>/
├── persona/
│   ├── CLAUDE.md / CRON.md     # source of truth (CLAUDE.md is symlinked into the repo)
│   ├── IDENTITY.md / USER.md / MEMORY.md / tasks.md
│   ├── tests/cases.md          # /assistant-test cases
│   └── .claude/skills/         # all your skills as real dirs - personal +
│       ├── kb-impl/            # copies of generic skills from share/skills/
│       ├── assistant-loop/     # (edit any of these freely; they're yours)
│       ├── ...
├── raw/                        # /kb ingest inbox
└── kb/ ...                     # whatever your kb-impl writes
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
- **Cron tasks don't fire on time** - check `data/cron-daemon.log`. Common cause: laptop slept past the scheduled minute. cron-daemon will fire on the next match after wake; sleep is a hard limit.
- **Cron tasks rejected with "TELEGRAM_CHAT_ID not set"** - bin scripts enforce a chat allowlist; ensure `.env` has `TELEGRAM_CHAT_ID=<your-id>` (or `TELEGRAM_CHAT_IDS=id1,id2` for multi-user).
- **Vault writes don't show up in Obsidian** - Google Drive bind-mounts on macOS sometimes lag a few seconds. Force-sync the Drive client or wait.
- **MCP OAuth errors** - claude.ai connectors (Gmail, Calendar, Notion) re-auth via `~/.claude/`. Run `claude` interactively to refresh the session.
- **`/kb <subcmd>` says "implementation not installed"** - run `cp -r share/skills/kb/examples/minimal "$VAULT_PATH/persona/.claude/skills/kb-impl"`. No relink needed.
