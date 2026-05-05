Back up `.claude/skills/` to the vault so skills survive instance migrations.

```bash
VAULT_SKILLS=/vault/persona/.claude/skills
mkdir -p "$VAULT_SKILLS"
for skill in assistant-loop assistant-test kb; do
  rm -rf "$VAULT_SKILLS/$skill"
  cp -r ".claude/skills/$skill" "$VAULT_SKILLS/$skill"
done
echo "backed up: assistant-loop, assistant-test, kb -> $VAULT_SKILLS"
```
