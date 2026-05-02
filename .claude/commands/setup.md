---
description: First-time setup for the persona repo - .env, vault layout, kb-impl, personal-skill symlinks. Idempotent.
---

# /setup

Run an interactive first-time setup wizard for the persona repo.

The goal is one continuous interactive flow that gets a fresh checkout from `git clone` to "ready to `/assistant-loop`". Detect what's already done and skip those steps - never overwrite user-edited files without asking.

## Flow

### 1. Detect state

Run a quick audit before asking anything. For each item, note done / missing / partial:

- `.env` exists at repo root, and has non-empty `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `VAULT_PATH`, `TZ`.
- `CLAUDE.md` at repo root is a symlink to `<vault>/persona/CLAUDE.md`, and the target file exists.
- `<vault>/persona/CRON.md` exists (optional - only if user wants scheduled tasks). No repo-root copy; cron-daemon reads it directly via `$VAULT_PATH`.
- Vault directory exists (path from `$VAULT_PATH` or `/vault` if running inside Docker).
- `<vault>/persona/` exists.
- `<vault>/persona/.claude/skills/kb-impl/` exists (any directory or symlink).
- `.claude/skills` in the repo is a symlink to `<vault>/persona/.claude/skills/`.

Tell the user what you found in 4-5 lines, then offer to fill the gaps.

### 2. .env (gather config)

For each missing value, ask one question at a time. Don't dump a multi-question prompt - this is a guided wizard.

**TELEGRAM_BOT_TOKEN**
- Tell them to talk to @BotFather, `/newbot`, copy the token.
- Validate by calling `https://api.telegram.org/bot<token>/getMe`. Expected: `{"ok":true,"result":{"username":"..."}}`. If `ok:false`, re-ask.

**TELEGRAM_CHAT_ID**
- Tell them to message @userinfobot to get their numeric chat_id.
- Validate by sending a test message:
  ```bash
  curl -s "https://api.telegram.org/bot<token>/sendMessage" \
    -d chat_id=<id> -d text="Setup test - if you see this, the bot can reach you."
  ```
- If they don't receive it, the chat_id is wrong (or they haven't messaged the bot yet - Telegram requires the user to start the bot first).

**VAULT_PATH**
- Ask for an absolute path to a folder they want to treat as their vault. Can be empty.
- If running inside Docker (`/vault` exists as a mount), use that as the in-container path; still ask for the host path to write into `.env` (docker-compose.yml resolves it from there).
- Quote the path if it contains spaces: `VAULT_PATH="/path with spaces/vault"`.
- `mkdir -p` the path if it doesn't exist.

**TZ**
- Default to the host's timezone if detectable (`readlink /etc/localtime` or `date +%Z`). Otherwise ask. Any IANA name works.

Write all values to `.env`. If `.env` already has some keys, edit in place rather than overwriting - preserve any custom keys the user added.

### 3. CLAUDE.md and CRON.md

Both files store personal config that belongs in the vault, but they're consumed differently:

- **`CLAUDE.md`** is auto-loaded by Claude Code from cwd, so the repo root must have a copy. We make it a symlink: real file at `<vault>/persona/CLAUDE.md`, repo root has `CLAUDE.md → <vault>/persona/CLAUDE.md` (gitignored).
- **`CRON.md`** is only read by `bin/cron-daemon.ts`, which resolves `$VAULT_PATH/persona/CRON.md` directly. No repo-root copy needed.

**For `CLAUDE.md`**, dispatch on state:

- **Vault file missing AND repo symlink missing**: copy `CLAUDE.example.md` to `<vault>/persona/CLAUDE.md`, then `ln -s "<vault>/persona/CLAUDE.md" CLAUDE.md`.
- **Vault file missing AND repo file is a regular file (not symlink)**: legacy layout. `mv CLAUDE.md "<vault>/persona/CLAUDE.md" && ln -s "<vault>/persona/CLAUDE.md" CLAUDE.md`. Tell the user what you did.
- **Vault file exists AND repo symlink missing**: just `ln -s "<vault>/persona/CLAUDE.md" CLAUDE.md`.
- **Both correct**: skip.

**For `CRON.md`**, ask first: "Want scheduled tasks (daily journal, weekly review, ...)?" If yes and `<vault>/persona/CRON.md` is missing, copy `CRON.example.md` to `<vault>/persona/CRON.md`. No symlink needed. If they decline, skip.

Use the absolute `$VAULT_PATH` from `.env` for the symlink target so it survives `cd` and works inside Docker (the Docker mount aliases `$VAULT_PATH` to `/vault`).

### 4. Vault skeleton + kb-impl

```bash
mkdir -p "$VAULT_PATH/persona/.claude/skills"
mkdir -p "$VAULT_PATH/raw"
```

If `<vault>/persona/.claude/skills/kb-impl/` is missing:
- Offer to copy the minimal flat-folder starter: `cp -r share/skills/kb/examples/minimal "$VAULT_PATH/persona/.claude/skills/kb-impl"`
- Tell them they can replace it later with PARA / Logseq / their own thing.

### 5. Wire up .claude/skills

```bash
./bin/link-skills.sh
```

First-run behavior: for each skill in `share/skills/` (assistant-loop, assistant-test, kb), copy it into the vault as a real dir, then symlink that vault copy back into `.claude/skills/<name>`. The script doesn't touch personal skills - those are the user's to manage. Show the output verbatim.

### 6. Wire up credentials

```bash
./bin/link-credentials.sh
```

For each entry in `credentials/` (e.g. `.gmail-mcp/`), symlink it into `$HOME` so tools find it at `~/.gmail-mcp`, etc. Idempotent - safe to re-run after adding a new credential dir. Symlinks (not copies) so OAuth refresh-token rewrites land in the single source of truth.

If `credentials/` doesn't exist yet, the script no-ops. Skip this step if the user has no third-party credentials to wire.

### 7. Final check + next step

Re-run the audit from step 1. Everything should be green. Then tell them:

```
Setup complete. Next steps:

  docker compose up -d --build              # if not already running
  docker compose exec persona claude        # attach (run /login first time)
  docker compose exec persona claude /assistant-loop

Then message your bot. Onboarding fills in IDENTITY.md and USER.md on the
first message - just say hi.
```

If they're already inside the running container, skip the docker lines and just tell them to run `/assistant-loop`.

## Re-runs

`/setup` is idempotent. Common re-run scenarios:

- **Switching vaults**: edit `VAULT_PATH` in `.env`, re-run `/setup`. It re-mkdirs the new vault skeleton and copies skills into it.
- **Added a new generic skill in `share/skills/`**: re-run just `./bin/link-skills.sh` (it installs missing skills, leaves existing ones alone).
- **Pulled repo updates and want them in the vault**: re-run `./bin/link-skills.sh`. For each shared skill that differs, it shows a diff and asks y/N before overwriting. Skills already in sync stay quiet.
- **Authoring a personal skill**: simplest is to create it directly in `.claude/skills/<name>/` (gitignored). If you want it backed up via the vault, put it under `<vault>/persona/.claude/skills/<name>/` and symlink it yourself - `link-skills.sh` only manages shared skills.
- **Rotated bot token**: edit `TELEGRAM_BOT_TOKEN` in `.env`, re-run `/setup` - it re-validates.
- **Added a new credential dir** (e.g. dropped `credentials/.foo-mcp/`): re-run just `./bin/link-credentials.sh`. It's idempotent and only links what's missing.

When re-running, default to "skip if exists" - only ask before overwriting if the user explicitly said they want to redo something.

## Don't

- Don't overwrite `CLAUDE.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, or `tasks.md` if they exist. These hold the user's personal config and must never be touched without explicit consent.
- Don't run `docker compose up` for the user. They might be on a host without Docker running, or already inside the container. Just tell them the command.
- Don't start `/assistant-loop` from inside `/setup`. Setup ends with instructions; the user kicks off the loop themselves.
