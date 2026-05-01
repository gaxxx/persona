---
name: kb
description: Personal knowledge base operations - interface only. Required ops are put/query/lint; any other subcommand (ingest, plan, clip, improve, ...) is implementation-defined and lives in the user's vault under .claude/skills/kb-impl/.
---

# kb - Knowledge Base Interface

Universal contract for storing and querying personal data. Other skills should call `/kb` instead of writing files directly so the on-disk layout (Obsidian + PARA, Logseq tag-only, plain folders, ...) is pluggable per-user.

## Required (interface contract)

| Command | What it must do |
|---|---|
| `/kb put <file> [--summary <article>] [--to <path>] [--rename <slug>]` | Persist `<file>`. With `--summary`, link to owner article (impl decides where on disk). With `--to`, place markdown at the given path. Return final absolute location. |
| `/kb query <question>` | Answer using kb content. Plain text or markdown ref to source articles. |
| `/kb lint [rule]` | Report health issues (broken links, duplicates, orphans, etc.). Do not auto-fix without explicit confirmation. |

## Implementation-defined (any other subcommand)

`/kb <anything-else>` routes to the user's implementation skill at `<vault>/.claude/skills/kb-impl/`. Common ops in this user's PARA + Obsidian impl:

- `/kb ingest` — process `<vault>/raw/` inbox
- `/kb plan` — OKR / goals management
- `/kb clip <url>` — clip a YouTube video into raw/
- `/kb improve` — multi-agent QA loop
- `/kb test` — redirects to `/assistant-test`

To see what your impl supports: `cat <vault>/.claude/skills/kb-impl/SKILL.md`.

## How to call from another skill

- **Always** route writes through `/kb put`. Never compute kb paths in your skill's source - the path shape is implementation-internal.
- Returned paths are stable enough to put in a `[[wikilink]]` for human navigation, not stable enough to hard-code anywhere a future implementation change would break.
- For Obsidian-style impls, `[[basename]]` wikilinks resolve across the vault. Treat this as best-effort across implementations.

## Implementation

This file is a stub. Concrete behavior comes from `<vault>/.claude/skills/kb-impl/SKILL.md` (and its `references/`). The `bin/link-personal-skills.sh` script symlinks the vault's `kb-impl` into this repo's `.claude/skills/` so Claude Code sees both the interface and the implementation.

If `kb-impl/` is missing on disk, `/kb <subcommand>` (other than the documented core 3) should respond: "kb implementation skill is not installed; configure `<vault>/.claude/skills/kb-impl/` per SETUP.md".

## Starting from scratch

A minimal flat-folder example implementation lives at [`examples/minimal/SKILL.md`](examples/minimal/SKILL.md). Copy it to your vault to get started:

```bash
cp -r .claude/skills/kb/examples/minimal "$VAULT_PATH/.claude/skills/kb-impl"
./bin/link-personal-skills.sh
```

Then edit the copy to fit your workflow (PARA, tagging, sibling folders, Dataview, ... whatever you like).
