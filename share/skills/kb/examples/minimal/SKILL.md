---
name: kb-impl
description: Minimal flat-folder kb implementation. Honors the put/query/lint contract from /kb. Copy this directory to <vault>/persona/.claude/skills/kb-impl/ as a starting point and customize from there.
---

# kb-impl (minimal example)

A minimum-viable implementation of the `/kb` interface. Stores everything as Markdown + binaries in a flat folder layout under `<vault>/kb/`, with date-bucketed catch-all and full-text grep for query. **No PARA, no Dataview, no Obsidian-specific features** - intentionally simple so it works for any vault.

Use this as a starting template:

```bash
cp -r <repo>/share/skills/kb/examples/minimal <vault>/persona/.claude/skills/kb-impl
# now edit <vault>/persona/.claude/skills/kb-impl/SKILL.md to customize
```

## Layout

```
<vault>/
├── raw/                       # inbox; /kb ingest moves things from here
└── kb/
    ├── notes/                 # markdown notes (flat; one file per topic)
    ├── attachments/           # binaries cited from notes
    └── archive/<YYYY-MM-DD>/  # catch-all for uncited binaries
```

## Required commands

### `/kb put <file> [--summary <article>] [--to <path>] [--rename <slug>]`

1. Detect file kind from extension. Markdown -> `kb/notes/<dest>.md`. Binary -> see below.
2. If `--rename <slug>` is given, use that as the basename; else preserve the original.
3. **Binary path**:
   - With `--summary <article>`: place in `kb/attachments/`. Append `[[<basename>]]` under a `## Sources` section in `<article>`. Create the article if missing.
   - Without `--summary`: place in `kb/archive/<YYYY-MM-DD>/<basename>` (date is today, or file mtime if mtime is >1 day older).
4. **Markdown path**:
   - With `--to <kb-path>`: write the file at `<kb-path>` (treat as relative to vault root). Create parent dirs.
   - Without `--to`: refuse - the user must specify where markdown goes.
5. Return the absolute final path.

Idempotency: if a file with the same sha-256 already exists at the target, skip and return that path.

### `/kb query <question>`

1. `grep -rli "<keywords>" kb/notes/` to find candidate articles.
2. Read top 3-5 hits.
3. Synthesize an answer that cites which articles you read (`[[basename]]`).
4. If nothing matches, say so plainly.

### `/kb lint [rule]`

Two minimum rules:

- **broken-links**: walk every `kb/**/*.md`, extract `[[basename]]` wikilinks, check if a file with that basename exists anywhere under `kb/`. Report misses.
- **orphans**: walk `kb/attachments/` and `kb/archive/**/`, find binaries whose basename is not wikilinked from any note. Report counts by directory.

## Implementation-defined commands (optional)

This minimal impl does NOT implement `/kb ingest`, `/kb plan`, `/kb clip`, etc. Add them as you grow:

- `/kb ingest`: scan `<vault>/raw/`, classify each file (markdown -> ask user where; binary -> auto to archive or ask), then call `/kb put` semantics.
- Whatever else fits your workflow.

## Customization ideas

- **Switch to PARA**: split `notes/` into `projects/` `areas/` `resources/` `archives/`.
- **Sibling-folder pattern**: replace `kb/attachments/` with per-article `<article>/assets/` (Obsidian convention).
- **Add Dataview hubs**: aggregate same-type articles via frontmatter `type:` fields.
- **Add `clip`**: shell out to `yt-dlp --skip-download --write-info-json --write-auto-sub` to clip videos into raw/.

See the maintainer's full implementation in `<vault>/persona/.claude/skills/kb-impl/` for one fleshed-out example (PARA + folder-note + Dataview + `assets/` subfolder).
