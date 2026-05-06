#!/bin/bash
# Back up `.claude/skills/` to the vault so skills survive instance migrations.
# Mirror image: bin/skrestore.sh.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ -z "${VAULT_PATH:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${VAULT_PATH:?VAULT_PATH not set — add it to .env}"

VAULT_SKILLS="$VAULT_PATH/persona/.claude/skills"
mkdir -p "$VAULT_SKILLS"

for skill in assistant-loop assistant-test kb; do
  rm -rf "$VAULT_SKILLS/$skill"
  cp -r ".claude/skills/$skill" "$VAULT_SKILLS/$skill"
done

echo "backed up: assistant-loop, assistant-test, kb -> $VAULT_SKILLS"
