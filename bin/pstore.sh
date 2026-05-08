#!/bin/bash
# Restore gitignored personal files from the vault backup (use after cloning
# on a new instance, or after losing local state). Mirror image: bin/pbackup.sh.
#
# Scope:
#   - personal skills (any skill in vault that's not in SHARED_SKILLS)
#   - CLAUDE.md, CLAUDE.local.md

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${VAULT_PATH:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${VAULT_PATH:?VAULT_PATH not set — add it to .env}"

VAULT_PERSONA="$VAULT_PATH/persona"
VAULT_SKILLS="$VAULT_PERSONA/.claude/skills"

SHARED_SKILLS=("assistant-loop" "assistant-test" "kb" "onboarding")

is_shared() {
  local name="$1"
  for s in "${SHARED_SKILLS[@]}"; do
    [ "$name" = "$s" ] && return 0
  done
  return 1
}

restored=()

# Personal skills
if [ -d "$VAULT_SKILLS" ]; then
  for dir in "$VAULT_SKILLS"/*/; do
    [ -d "$dir" ] || continue
    name="$(basename "$dir")"
    if is_shared "$name"; then continue; fi
    rm -rf ".claude/skills/$name"
    cp -r "$dir" ".claude/skills/$name"
    restored+=("skill:$name")
  done
fi

# CLAUDE.md / CLAUDE.local.md
for f in CLAUDE.md CLAUDE.local.md; do
  src="$VAULT_PERSONA/$f"
  [ -f "$src" ] || continue
  cp "$src" "$f"
  restored+=("$f")
done

if [ "${#restored[@]}" -eq 0 ]; then
  echo "nothing to restore (vault has no personal skills or CLAUDE files)"
else
  echo "restored from $VAULT_PERSONA: ${restored[*]}"
fi
