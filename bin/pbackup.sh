#!/bin/bash
# Back up gitignored personal files to the vault so they survive instance
# migrations / re-clones. Mirror image: bin/prestore.sh.
#
# Scope:
#   - personal skills under .claude/skills/<name>/  (those NOT in SHARED_SKILLS,
#     which are committed to git per .gitignore exception list)
#   - CLAUDE.local.md (optional personal-overrides split, if present)
#   - mcp-credentials/ (gmail oauth tokens etc — watchdog symlinks into $HOME)
#
# NOT in scope:
#   - CLAUDE.md — now tracked in git, no vault copy needed
#   - USER.md, IDENTITY.md, MEMORY.md, tasks.md, CRON.md (live in vault directly)
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

# CLAUDE.local.md (personal overrides only — CLAUDE.md is now in git)
if [ -f "CLAUDE.local.md" ]; then
  cp CLAUDE.local.md "$VAULT_PERSONA/CLAUDE.local.md"
  backed_up+=("CLAUDE.local.md")
fi

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
