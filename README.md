# persona

A personal Telegram-driven assistant powered by Claude Code.

You message a Telegram bot; an LLM with access to your knowledge base, calendar, email, and any custom skills you write replies in your voice and on your terms. Each user runs their own instance with their own bot, vault, and personal skills — no shared backend.

<!-- screenshot/GIF goes here once recorded -->

## Quickstart

```bash
git clone https://github.com/gaxxx/persona && cd persona
./setup.sh                                  # interactive: token, vault, TZ, deploy mode
docker compose exec persona tmux a -t loop  # if you picked Docker; Ctrl-B D to detach
```

Then send your Telegram bot a message — first one triggers onboarding.

Get your telegram bot ready and set up in 3 minutes.

https://github.com/user-attachments/assets/42251ab8-9890-4ce3-a63e-c446d85ac4fb


## Status & scope

This is a **personal scaffold**, not a SaaS product. The repo holds the harness (Telegram I/O, cron, watchdog, skill loader, kb interface stub); your data, identity, and most skills live in your own vault outside git.

That shape is intentional. PRs that fix bugs or improve the shared harness are welcome; PRs that bake one person's workflow into the harness are not — those belong in *your* `kb-impl/` or personal skills. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Requirements

- **Claude Code** — paid Anthropic plan or API access. The harness drives `claude` as a subprocess; no plan, no bot.
- **Bun** (`brew install oven-sh/bun/bun`) — or Docker, which bundles it.
- **A Telegram bot** — `/newbot` to [@BotFather](https://t.me/BotFather); save the token.
- **An Obsidian vault** — or any folder you'll treat as one. Your data lives here.

## What it does

- **Chat over Telegram.** Send a text, photo, document, or sticker; the assistant reads it, picks a skill or replies directly, and writes back.
- **Runs scheduled tasks.** A separate cron daemon reads `CRON.md` and fires prompts (or shell scripts) on schedule — daily journal, weekly review, mailbox digest, calendar lookahead, …
- **Talks to your knowledge base.** A pluggable `/kb` skill with a fixed `put` / `query` / `lint` contract — you ship your own implementation against it.
- **Composes with MCP.** Gmail, Google Calendar, Drive, Notion, GitHub, and any other MCP server you wire up are just tools the assistant can pick.

## Architecture

Three independent processes talk to a shared filesystem and persona config:

- `bin/tg-daemon.ts` — long-running Telegram I/O. Owns a persistent `claude -p --input-format stream-json` subprocess that handles every message in the same session.
- `bin/cron-daemon.ts` — reads `CRON.md`, schedules each task by its cron expression, spawns either `claude -p` (for LLM tasks) or `sh -c` (for deterministic scripts) on fire. Auto-reloads on file change.
- `bin/watchdog.sh` — bash supervisor (no LLM). Polls every 60s, respawns either daemon if dead, Telegram-alerts on respawn. Spawned by `/assistant-loop` and disowned, so it survives REPL exit.
- The interactive REPL you `claude` into — ad-hoc work and on-demand status checks via `/assistant-loop`.

## Extension points

The interesting design is the layering. Five places you can extend without forking:

### 1. `/kb` — interface vs. implementation

`/kb put`, `/kb query`, `/kb lint` are a fixed contract. The on-disk layout (PARA, Logseq, flat folders, tag-only, …) is entirely up to your `kb-impl/` skill in `<vault>/persona/.claude/skills/kb-impl/`. Other skills call `/kb put <file>` and use the returned path — they never compute kb paths themselves. A minimal starter implementation ships at `.claude/skills/kb/examples/minimal/`.

### 2. Skills — three layers

| Layer | Where | When to use |
|---|---|---|
| **Shared** | `.claude/skills/<name>/` (tracked) | Useful to all users (current set: `assistant-loop`, `assistant-test`, `kb`, `onboarding`). Add via PR. |
| **Personal** | `.claude/skills/<name>/` (gitignored, mirrored to `<vault>/persona/.claude/skills/`) | Bound to your life: `game-time`, `uscis-check`, perf-review notes, etc. |
| **kb-impl** | `<vault>/persona/.claude/skills/kb-impl/` | The one skill that implements the `/kb` contract. Replace freely. |

Personal skills auto-sync between repo and vault via `bin/pbackup.sh` (Stop hook, runs after every Claude Code session) and `bin/prestore.sh` (manual, vault → repo). The vault is source-of-truth; the repo is a working copy. Don't commit personal skills.

### 3. `CRON.md` — `Prompt:` vs `Shell:`

Each task in `<vault>/persona/CRON.md` is either:

- **`Prompt:`** — cron-daemon spawns `claude -p` with the prompt block. Use when LLM judgment matters (classify, summarize, compose).
- **`Shell:`** — cron-daemon runs `sh -c <command>`. Use for deterministic wrapper scripts (`bun run bin/foo.ts`). Free, fast, debuggable.

Rule of thumb: write a `bin/foo.ts` wrapper for repeated/stateful tasks (gmail-digest, daily-journal) and let it shell out to `claude -p` only for the parts that actually need a model. fs.watch on `CRON.md` reloads tasks within ~500ms — no daemon restart needed.

### 4. MCP servers — `.mcp.json`

Copy `.mcp.example.json` to `.mcp.json` (gitignored) and add your servers. stdio servers spawn locally; HTTP servers connect remote. The assistant picks them automatically based on the active tool list — no code changes needed to plug in a new MCP.

### 5. Personality & identity

`<vault>/persona/IDENTITY.md`, `USER.md`, and the top-level `CLAUDE.md` are the levers for tone, language, quiet hours, memory rules. Onboarding fills the first two; the rest you tweak by hand. CLAUDE.md in particular is gitignored and synced via pbackup/prestore, so each user has their own without forking the repo.

## Design choices

A few non-obvious decisions and what they trade off:

### Markdown + filesystem, not SQLite / a DB

Plain markdown in your Obsidian vault, searched with ripgrep. The `kb-impl` skill is pluggable — swap in SQLite, embeddings, or whatever fits your data when you outgrow grep.

### Rotate the inner `claude` subprocess, don't fight it

Humans take naps; so does the assistant. Let it crash, rebuild the memory from disk. Defaults: 4h / 25 turns / 500K cache_read tokens, whichever fires first.

## Learning from Claude Code's auto-memory

*2026-05-14*

Patterns borrowed from Claude Code's built-in auto-memory system (the one that lives in `~/.claude-loop/.../memory/`, not the third-party `claude-mem` skill):

- **Typed memory** (`user` / `feedback` / `project` / `reference`) with an index + per-entry frontmatter, instead of one flat MEMORY.md
- **Proactive triggers** — save on user corrections *and* confirmations, not just explicit "记住" / "remember"
- **Why + How to apply** structure for feedback/project entries, so future-you can judge edge cases instead of mechanically following rules
- **Stale memory verification** — trust live observation over stored fact when they conflict; update or drop the memory rather than parroting it

## Why a separate repo per user

The repo holds the harness; your vault holds you. Personal data (identity, preferences, the knowledge base itself) lives outside the tracked tree, so the same code can be cloned and personalized by anyone without leaking the previous owner's life into git history.

## More

- [SETUP.md](./SETUP.md) — long-form setup walkthrough (manual + Docker + native)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — scope, bug reports, PRs
- [LICENSE](./LICENSE) — MIT

## Acknowledgments

Built with love, and dedicated to my wife — whose patience and care while we renovated our home reminded me what it looks like to build something thoughtfully, one decision at a time.
