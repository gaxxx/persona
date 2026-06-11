---
name: kb-impl
description: Minimal evolving-wiki kb implementation. Honors the put/query/lint contract from /kb. Flat markdown pages that the LLM grows, merges, splits, and links as a side effect of normal use. Copy this directory to <vault>/persona/.claude/skills/kb-impl/ as a starting point and customize from there.
---

# kb-impl (minimal example) — an evolving LLM wiki

A minimum-viable implementation of the `/kb` interface, designed around one idea: **the kb is a wiki that the LLM gardens while using it**. Pages aren't write-once notes — every read or write is a chance to merge a new fact, fix a stale one, add a link, or split an overgrown page. Plain Markdown + grep, no PARA, no Dataview, no embeddings — intentionally simple so it works for any vault and survives any tooling change.

Use this as a starting template:

```bash
cp -r <repo>/.claude/skills/kb/examples/minimal <repo>/.claude/skills/kb-impl
# now edit .claude/skills/kb-impl/SKILL.md to customize
# (Stop hook auto-pushes it to <vault>/persona/.claude/skills/kb-impl/)
```

## Layout

```
<vault>/
├── raw/                       # inbox; /kb ingest moves things from here
└── kb/
    ├── notes/                 # wiki pages (flat; ONE topic per page)
    │   └── INDEX.md           # the map: one line per page, auto-maintained
    ├── attachments/           # binaries cited from pages
    └── archive/<YYYY-MM-DD>/  # catch-all for uncited binaries
```

## Page anatomy

```markdown
---
description: one-line hook — what questions this page answers
updated: 2026-06-11
---

Short, current facts. Dense [[wikilinks]] to related pages.

## Sources
- [[mortgage-closing-2026.pdf]]
```

`INDEX.md` mirrors every page: `- [[<basename>]] — <description>`. It is the cheap routing layer — query reads it before grepping.

## The wiki evolves on touch

These rules apply to **every** command below. They are what make this a wiki instead of a log:

1. **Update in place, never append-only.** A new fact about an existing topic gets merged where it belongs. A contradicting fact replaces the old one (newest wins); keep the old value inline only when history matters ("rate 6.25%, was 6.8% until 2026-05").
2. **One topic per page; search before creating.** Before writing a new page, check `INDEX.md` and `grep -rli` over `kb/notes/` — most "new" facts belong on an existing page. Create only when nothing fits.
3. **Link liberally; red links are growth points.** `[[wikilink]]` related pages whenever mentioned. A link to a page that doesn't exist yet is fine — it marks a page worth creating, not an error.
4. **Split when overgrown.** A page past ~120 lines or covering two clearly separable topics gets split into child pages; the parent keeps a 2-3 line summary per child + link. **Merge** when two pages keep saying the same thing.
5. **Every write stamps `updated:` and syncs the page's `INDEX.md` line.** Convert relative dates to absolute when writing ("下周四" → `2026-06-18`) — otherwise pages rot.

## Required commands

### `/kb put <file> [--summary <article>] [--to <path>] [--rename <slug>]`

1. Detect file kind from extension. With `--rename <slug>`, use it as the basename; else preserve the original.
2. **Binary path**:
   - With `--summary <article>`: place in `kb/attachments/`. Append `[[<basename>]]` under the `## Sources` section of `<article>` (create the page if missing — with frontmatter and an INDEX line).
   - Without `--summary`: place in `kb/archive/<YYYY-MM-DD>/<basename>` (date is today, or file mtime if mtime is >1 day older).
3. **Markdown path**:
   - With `--to <kb-path>`: write at `<kb-path>` (relative to vault root). Create parent dirs.
   - Without `--to`: apply evolve rule 2 — if an existing page covers the topic, **merge the content into it** (rule 1) and report that; else create `kb/notes/<slug>.md`.
4. Stamp `updated:`, sync `INDEX.md` (create it on first put).
5. Return the absolute final path.

Idempotency: if a file with the same sha-256 already exists at the target, skip and return that path.

### `/kb query <question>`

1. Read `kb/notes/INDEX.md` — descriptions route most questions in one read.
2. Grep fallback: `grep -rli "<keywords>" kb/notes/` for anything the index didn't surface.
3. Read the top 3-5 candidate pages; synthesize an answer citing them (`[[basename]]`).
4. If nothing matches, say so plainly — and if the conversation already contains the answer, offer to save it as a page.
5. **Evolve on read**: if a page you read is contradicted by fresher context (the user's message, a newer page), fix it now per rule 1. Reading is gardening.

### `/kb lint [rule]`

Report, don't auto-fix (except where noted). Four rules:

- **broken-links**: `[[links]]` to attachments/binaries that don't exist anywhere under `kb/` — real errors.
- **red-links**: `[[links]]` to *pages* that don't exist — not errors; report as "suggested pages" sorted by inbound-link count. This is the wiki's growth backlog.
- **index-drift**: pages missing from `INDEX.md`, index lines pointing at deleted pages, or descriptions that no longer match frontmatter. Safe to auto-fix; say what changed.
- **orphans**: binaries under `kb/attachments/` and `kb/archive/**/` not wikilinked from any page. Report counts by directory.

## Implementation-defined commands (optional)

This minimal impl does NOT implement `/kb ingest`, `/kb plan`, `/kb clip`, etc. Add them as you grow:

- `/kb ingest`: scan `<vault>/raw/`, classify each file, then apply `/kb put` semantics.
- `/kb gc`: interactive pass over stale pages (`updated:` > 90 days) — confirm still true, refresh, or archive.
- Whatever else fits your workflow.

## Customization ideas

- **Switch to PARA**: split `notes/` into `projects/` `areas/` `resources/` `archives/` (keep INDEX.md at `kb/` root).
- **Sibling-folder pattern**: replace `kb/attachments/` with per-article `<article>/assets/` (Obsidian convention).
- **Add Dataview hubs**: aggregate same-type pages via frontmatter `type:` fields.
- **Add `clip`**: shell out to `yt-dlp --skip-download --write-info-json --write-auto-sub` to clip videos into raw/.

See the maintainer's full implementation in `.claude/skills/kb-impl/` (gitignored, backed up to `<vault>/persona/.claude/skills/kb-impl/`) for one fleshed-out example (PARA + folder-note + Dataview + `assets/` subfolder).
