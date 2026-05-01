#!/bin/bash
# Symlink personal skills from <vault>/.claude/skills/ into repo's .claude/skills/.
# Repo ships only generic skills (assistant-loop, assistant-test). Personal
# skills (kb, game-time, ds160, ...) live in the vault next to their data, and
# this script links them back so Claude Code in this repo can see them.
#
# Run after `git clone`, after switching vaults, or whenever a new personal
# skill is added in the vault. Idempotent.
#
# Reads VAULT_PATH from .env (or falls back to first arg).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

VAULT_PATH="${VAULT_PATH:-${1:-}}"
if [ -z "$VAULT_PATH" ]; then
  echo "FATAL: VAULT_PATH not set (in .env or as arg)" >&2
  exit 1
fi

VAULT_SKILLS="$VAULT_PATH/.claude/skills"
REPO_SKILLS="$REPO_ROOT/.claude/skills"

if [ ! -d "$VAULT_SKILLS" ]; then
  echo "no $VAULT_SKILLS - nothing to link"
  exit 0
fi

mkdir -p "$REPO_SKILLS"

linked=0
skipped=0
for src in "$VAULT_SKILLS"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  dst="$REPO_SKILLS/$name"
  if [ -L "$dst" ]; then
    # already a symlink - update if pointing elsewhere
    current="$(readlink "$dst")"
    if [ "$current" != "$src" ] && [ "$current" != "${src%/}" ]; then
      ln -sfn "${src%/}" "$dst"
      echo "relinked $name -> ${src%/}"
      linked=$((linked + 1))
    else
      skipped=$((skipped + 1))
    fi
  elif [ -e "$dst" ]; then
    echo "SKIP $name (real dir/file exists at $dst; not overwriting)" >&2
    skipped=$((skipped + 1))
  else
    ln -sfn "${src%/}" "$dst"
    echo "linked $name -> ${src%/}"
    linked=$((linked + 1))
  fi
done

echo "done: linked $linked, skipped $skipped"
