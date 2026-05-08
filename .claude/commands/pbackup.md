Back up gitignored personal files (personal skills + CLAUDE.md + CLAUDE.local.md) to the vault so they survive instance migrations.

```bash
bash bin/pbackup.sh
```

Scope:
- `.claude/skills/<personal>/` — any skill not in `SHARED_SKILLS` (committed via `.gitignore` exceptions)
- `CLAUDE.md`, `CLAUDE.local.md`

Out of scope (already lives in vault directly):
- `USER.md`, `IDENTITY.md`, `MEMORY.md`, `tasks.md`, `CRON.md`
