#!/bin/bash
# Back up gitignored personal files to the vault so they survive instance
# migrations / re-clones. Mirror image: bin/pstore.sh.
#
# Scope:
#   - personal skills under .claude/skills/<name>/  (those NOT in SHARED_SKILLS,
#     which are committed to git per .gitignore exception list)
#   - CLAUDE.md (real file at repo root)
#   - CLAUDE.local.md (optional personal-overrides split)
#   - mcp-credentials/ (gmail oauth tokens etc — watchdog symlinks into $HOME)
#
# NOT in scope (lives in vault directly, no repo copy):
#   - USER.md, IDENTITY.md, MEMORY.md, tasks.md, CRON.md
#   - daemon runtime state under data/

set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${VAULT_PATH:-}" ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi
: "${VAULT_PATH:?VAULT_PATH not set — add it to .env}"

VAULT_PERSONA="$VAULT_PATH/persona"
VAULT_SKILLS="$VAULT_PERSONA/.claude/skills"
mkdir -p "$VAULT_SKILLS"

# Skills committed to git (per .gitignore exception list) — skip these.
# Keep this list in sync with .gitignore.
SHARED_SKILLS=("assistant-loop" "assistant-test" "kb" "onboarding")

is_shared() {
  local name="$1"
  for s in "${SHARED_SKILLS[@]}"; do
    [ "$name" = "$s" ] && return 0
  done
  return 1
}

backed_up=()

# Personal skills
for dir in .claude/skills/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  if is_shared "$name"; then continue; fi
  rm -rf "$VAULT_SKILLS/$name"
  cp -r "$dir" "$VAULT_SKILLS/$name"
  backed_up+=("skill:$name")
done

# CLAUDE.md / CLAUDE.local.md
for f in CLAUDE.md CLAUDE.local.md; do
  if [ -f "$f" ]; then
    cp "$f" "$VAULT_PERSONA/$f"
    backed_up+=("$f")
  fi
done

# MCP credentials — see watchdog's link_mcp_credentials(). Refresh tokens are
# long-lived (months/years for Google OAuth), so a backup stays usable even
# after the in-place credentials.json gets rewritten by token refresh.
if [ -d mcp-credentials ]; then
  rm -rf "$VAULT_PERSONA/mcp-credentials"
  cp -r mcp-credentials "$VAULT_PERSONA/mcp-credentials"
  backed_up+=("mcp-credentials")
fi

if [ "${#backed_up[@]}" -eq 0 ]; then
  echo "nothing to back up"
else
  echo "backed up to $VAULT_PERSONA: ${backed_up[*]}"
fi
