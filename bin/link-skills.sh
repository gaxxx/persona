#!/bin/bash
# Wire up the .claude/skills/ directory.
#
# Layout (vault is the source of truth):
#   <vault>/persona/.claude/skills/      <- real dir; holds personal skills + symlinks to repo's generic skills
#   <repo>/.claude/skills                <- symlink -> <vault>/persona/.claude/skills/
#   <repo>/share/skills/<name>/          <- generic skills shipped with the repo
#
# Idempotent. Run after `git clone`, after switching vaults, or whenever a
# generic skill is added or removed in share/skills/.
#
# Reads VAULT_PATH from .env (or first arg).
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

VAULT_SKILLS="$VAULT_PATH/persona/.claude/skills"
REPO_SKILLS_LINK="$REPO_ROOT/.claude/skills"
SHARE="$REPO_ROOT/share/skills"

mkdir -p "$VAULT_SKILLS"

# 1. Make .claude/skills a symlink to the vault dir.
if [ -L "$REPO_SKILLS_LINK" ]; then
  current="$(readlink "$REPO_SKILLS_LINK")"
  if [ "$current" != "$VAULT_SKILLS" ]; then
    ln -sfn "$VAULT_SKILLS" "$REPO_SKILLS_LINK"
    echo "relinked .claude/skills -> $VAULT_SKILLS"
  fi
elif [ -e "$REPO_SKILLS_LINK" ]; then
  echo "FATAL: $REPO_SKILLS_LINK exists and is not a symlink. Refusing to overwrite." >&2
  echo "       Move its contents into $VAULT_SKILLS, then 'rm -rf' the directory and re-run." >&2
  exit 1
else
  mkdir -p "$(dirname "$REPO_SKILLS_LINK")"
  ln -s "$VAULT_SKILLS" "$REPO_SKILLS_LINK"
  echo "linked .claude/skills -> $VAULT_SKILLS"
fi

# 2. Seed the vault with symlinks back to each generic skill in share/skills/.
#    Real dirs in the vault (= personal skills) are left alone.
linked=0
skipped=0
if [ -d "$SHARE" ]; then
  for src in "$SHARE"/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    dst="$VAULT_SKILLS/$name"
    target="${src%/}"
    if [ -L "$dst" ]; then
      current="$(readlink "$dst")"
      if [ "$current" != "$target" ]; then
        ln -sfn "$target" "$dst"
        echo "relinked $name -> $target"
        linked=$((linked + 1))
      else
        skipped=$((skipped + 1))
      fi
    elif [ -e "$dst" ]; then
      echo "SKIP $name (real dir/file at $dst; not overwriting personal skill)" >&2
      skipped=$((skipped + 1))
    else
      ln -s "$target" "$dst"
      echo "linked $name -> $target"
      linked=$((linked + 1))
    fi
  done
fi

echo "done: linked $linked, skipped $skipped"
