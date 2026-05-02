#!/bin/bash
# Wire up the shared skills.
#
# For each skill in share/skills/:
#   1. If it's missing from <vault>/persona/.claude/skills/<name>/, copy it in.
#      If it exists and matches share/skills/ exactly, leave it alone.
#      If it exists and differs, show the diff and ask y/N before overwriting.
#   2. Symlink the vault copy back into <repo>/.claude/skills/<name>.
#
# This script does NOT touch personal skills. /setup ships separately as
# a tracked slash command at .claude/commands/setup.md - not a skill.
#
# Reads VAULT_PATH from .env (or first positional arg).
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
REPO_SKILLS="$REPO_ROOT/.claude/skills"
SHARE="$REPO_ROOT/share/skills"

mkdir -p "$VAULT_SKILLS" "$REPO_SKILLS"

if [ ! -d "$SHARE" ]; then
  echo "no $SHARE - nothing to do"
  exit 0
fi

installed=0
updated=0
linked=0
kept=0

for src in "$SHARE"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  vault_dst="$VAULT_SKILLS/$name"
  repo_dst="$REPO_SKILLS/$name"
  src_path="${src%/}"

  # 1. Reconcile share/skills/<name> -> vault.
  if [ -L "$vault_dst" ]; then
    # Stale symlink from a previous layout - replace with a real copy.
    rm "$vault_dst"
    cp -R "$src_path" "$vault_dst"
    echo "migrated $name in vault (symlink -> real copy)"
    installed=$((installed + 1))
  elif [ ! -e "$vault_dst" ]; then
    cp -R "$src_path" "$vault_dst"
    echo "installed $name in vault"
    installed=$((installed + 1))
  elif diff -qr "$vault_dst" "$src_path" >/dev/null 2>&1; then
    # In sync - nothing to do.
    kept=$((kept + 1))
  else
    echo
    echo "=== $name differs from share/skills/<name> ==="
    diff -ruN "$vault_dst" "$src_path" || true
    echo
    printf "Overwrite vault copy of %s with share/skills/? [y/N] " "$name"
    read -r reply
    if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
      rm -rf "$vault_dst"
      cp -R "$src_path" "$vault_dst"
      echo "updated $name in vault"
      updated=$((updated + 1))
    else
      echo "kept $name (vault copy untouched)"
      kept=$((kept + 1))
    fi
  fi

  # 2. Symlink vault copy back into .claude/skills/.
  if [ -L "$repo_dst" ]; then
    current="$(readlink "$repo_dst")"
    if [ "$current" != "$vault_dst" ]; then
      ln -sfn "$vault_dst" "$repo_dst"
      echo "relinked .claude/skills/$name -> $vault_dst"
    fi
  elif [ -e "$repo_dst" ]; then
    echo "SKIP $name (real dir at $repo_dst; not overwriting)" >&2
  else
    ln -s "$vault_dst" "$repo_dst"
    echo "linked .claude/skills/$name -> $vault_dst"
    linked=$((linked + 1))
  fi
done

echo "done: installed $installed, updated $updated, kept $kept, linked $linked"
