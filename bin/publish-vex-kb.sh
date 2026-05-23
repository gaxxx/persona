#!/bin/bash
# Sync vault/kb/vex/ → GitHub repo → Cloudflare Pages auto-deploys.
# Run this whenever you update KB notes (locally or in Docker via VAULT_PATH).
#
# Usage:
#   bin/publish-vex-kb.sh                    # sync and push
#   bin/publish-vex-kb.sh --dry-run          # preview changes only

set -euo pipefail

GITHUB_USER="gaxxx"
REPO_NAME="vex-team"
VAULT_VEX_DIR="${VAULT_PATH:-/vault}/kb/vex"
DRY_RUN=false

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "(dry-run mode — no changes will be pushed)"
fi

# Find the local clone of the vex-team repo
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)/../${REPO_NAME}"
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "✗ Repo not found at $REPO_DIR"
  echo "  Run bin/setup-vex-kb.sh first, or set REPO_DIR manually."
  exit 1
fi

echo "==> Syncing $VAULT_VEX_DIR → $REPO_DIR/content/ ..."

if $DRY_RUN; then
  rsync -av --dry-run --delete \
    --exclude='.obsidian' \
    --exclude='*.canvas' \
    "$VAULT_VEX_DIR/" "$REPO_DIR/content/"
else
  rsync -av --delete \
    --exclude='.obsidian' \
    --exclude='*.canvas' \
    "$VAULT_VEX_DIR/" "$REPO_DIR/content/"
fi

cd "$REPO_DIR"

CHANGED=$(git status --porcelain | wc -l | tr -d ' ')
if [ "$CHANGED" -eq "0" ]; then
  echo "✓ Nothing changed — KB is already up to date."
  exit 0
fi

echo "==> Changed files:"
git status --short

if $DRY_RUN; then
  echo "(dry-run: skipping commit and push)"
  exit 0
fi

git add -A
TIMESTAMP=$(date '+%Y-%m-%d %H:%M')
git commit -m "kb: sync VEX notes ${TIMESTAMP}"
git push

echo ""
echo "✓ Pushed! Cloudflare Pages will auto-deploy in ~1 minute."
echo "  Site: https://vex-team.pages.dev"
