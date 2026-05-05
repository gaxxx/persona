#!/bin/bash
# Restore `.claude/skills/` from the vault backup (use after cloning on a new
# instance). Mirror image: bin/skbackup.sh.

set -euo pipefail

cd "$(dirname "$0")/.."

set -a; [ -f .env ] && . ./.env; set +a
: "${VAULT_PATH:?VAULT_PATH not set — add it to .env}"

VAULT_SKILLS="$VAULT_PATH/persona/.claude/skills"

for skill in assistant-loop assistant-test kb; do
  if [ ! -d "$VAULT_SKILLS/$skill" ]; then
    echo "SKIP $skill (not in vault backup)"
    continue
  fi
  rm -rf ".claude/skills/$skill"
  cp -r "$VAULT_SKILLS/$skill" ".claude/skills/$skill"
  echo "restored $skill"
done
