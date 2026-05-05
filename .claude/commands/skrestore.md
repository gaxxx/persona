Restore `.claude/skills/` from the vault backup (use after cloning on a new instance).

```bash
VAULT_SKILLS=/vault/persona/.claude/skills
for skill in assistant-loop assistant-test kb; do
  if [ ! -d "$VAULT_SKILLS/$skill" ]; then
    echo "SKIP $skill (not in vault backup)"
    continue
  fi
  rm -rf ".claude/skills/$skill"
  cp -r "$VAULT_SKILLS/$skill" ".claude/skills/$skill"
  echo "restored $skill"
done
```
