# Vault Structure

Map of this Obsidian vault for skills that need to read or write artifacts. **Edit this file to describe your own layout** — `/kb` and other skills read it to know where things go.

## Required directories

```
<vault>/
├── STRUCTURE.md      # this file (canonical map of your vault)
├── raw/              # temporary inbox; /kb ingest classifies into kb/
├── kb/               # your knowledge base
└── persona/          # assistant config — CLAUDE.md, USER.md, IDENTITY.md, MEMORY.md, tasks.md, CRON.md
```

The `.obsidian/` folder appears once Obsidian opens the vault; leave it alone. `output/` is created lazily for ephemeral query results.

## Organize `kb/` however you want

This template doesn't prescribe an internal layout for `kb/`. Pick one that suits you, then document it below so `/kb` skills follow your convention.

Common patterns:

- **PARA** — `kb/{projects,areas,resources,archives}/`. Time-bound vs ongoing vs reference vs done.
- **Flat** — everything directly in `kb/<topic>.md`. Simplest. Works if you don't have many notes.
- **By topic** — `kb/{work,family,finance,health}/`. Mirrors how you think about life.
- **Logseq-style** — `kb/pages/` + `kb/journals/`. If migrating from Logseq.
- **Custom** — your own.

Whichever you pick, **edit this file** to spell it out: the `/kb` skill consults it before placing files.

### Example: minimal flat layout

```
kb/
├── house-renovation.md
├── visa-status.md
├── kitchen-electrical/         (folder note for files with attachments)
│   ├── kitchen-electrical.md
│   └── assets/
└── archives/
    └── 2026-04-10/             (date-bucketed catch-all for un-cited binaries)
        └── old-receipt.pdf
```

### Example: PARA layout

```
kb/
├── projects/<project>.md
├── areas/<topic>.md
├── resources/<reference>.md
└── archives/<project>-<year>.md  +  <YYYY-MM-DD>/
```

(Replace this section with your own example once you've decided.)

## Attachments live with their notes

Two layouts depending on whether an article has attachments:

**No attachments — stay flat:**
```
kb/<topic>.md
```

**Has attachments — folder note + assets:**
```
kb/<topic>/
├── <topic>.md          # the article (folder note, same name as folder)
├── <sub-page>.md       # peer sub-pages, if any
└── assets/             # all attachments
    └── <file>.pdf
```

A folder note is just an `.md` whose basename equals its parent directory's name. `[[<topic>]]` still basename-resolves to it. Sub-pages live as peers, not inside `assets/`.

In Obsidian: **Files & Links → Default location for new attachments → "In subfolder under current folder" → Subfolder name: `assets`** so new attachments land in the right place automatically.

**Implicit ownership.** A file inside `<X>/assets/` is owned by `<X>/<X>.md` even without an explicit wikilink.

## Naming

| Pattern | Example |
|---|---|
| kebab-case lowercase, `.md` | `house-renovation.md` |
| non-Latin chars OK | `装修-2315.md` |
| daily journal: strict `YYYY-MM-DD.md` | `2026-04-29.md` |
| sibling folder = note's stem | `house-renovation/` |
| date-bucketed archive | `archives/2026-04-10/foo.pdf` |

Attachments preserve their original filename. Forbidden chars stripped: `:*?"<>|`. Spaces, parens, non-Latin chars OK.

## Frontmatter

Minimal required:

```yaml
---
tags: [topic, subtopic]
updated: 2026-04-30
---
```

Add `status: active | paused | done` for time-bound work. Add other fields as your workflow needs.

## Body conventions

- First H1 is the article title.
- One-paragraph description right under the H1.
- `## Sources` near the bottom listing `[[file.ext]]` wikilinks.
- `## Related` for cross-links to other kb articles.
- **Latest-first** for chronological content.

## How skills should use it

Most skills shouldn't need to know exact paths. Use `/kb put`:

- **Binary + summary note** → `/kb put <file> --summary kb/<your-path>/<topic>.md`
- **Binary, no owner yet** → `/kb put <file>` (lands in `kb/archives/<YYYY-MM-DD>/<file>`)
- **Markdown** → `/kb put <file> --to kb/<your-path>/<topic>.md`
- **Daily journal** → auto-detected from `YYYY-MM-DD.md` filename
- **Ad-hoc inbox** → drop in `<vault>/raw/` and run `/kb ingest`

Don't write directly under `kb/` from other skills — go through `/kb put` so naming, sibling-folder placement, and dedup stay consistent.

## Topic resolution

Topic is **derived**, not stored. A file belongs to topic X iff some note about X cites it under `## Sources`, or its physical location is the sibling folder of an X-related article.
