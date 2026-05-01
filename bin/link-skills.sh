#!/bin/bash
# Wire up the shared skills.
#
# For each skill in share/skills/:
#   1. Copy it into <vault>/persona/.claude/skills/<name>/ if missing. Existing
#      vault copies are left alone unless --update is passed; with --update,
#      the script shows a diff and asks y/N before overwriting each one. Your
#      vault copy is the working version you're free to edit.
#   2. Symlink that vault copy back into <repo>/.claude/skills/<name>.
#
# This script does NOT touch personal skills. The 'setup' skill is also
# excluded - it ships as a tracked real dir at .claude/skills/setup/.
#
# Reads VAULT_PATH from .env (or first positional arg after flags).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

UPDATE=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --update|-u) UPDATE=1 ;;
    *) ARGS+=("$a") ;;
  esac
done

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

VAULT_PATH="${VAULT_PATH:-${ARGS[0]:-}}"
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

copied=0
updated=0
linked=0
relinked=0
skipped=0

for src in "$SHARE"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  vault_dst="$VAULT_SKILLS/$name"
  repo_dst="$REPO_SKILLS/$name"
  src_path="${src%/}"

  # 1. Copy share/skills/<name> into the vault.
  if [ -L "$vault_dst" ]; then
    rm "$vault_dst"
    cp -R "$src_path" "$vault_dst"
    echo "migrated $name in vault (symlink -> real copy)"
    copied=$((copied + 1))
  elif [ -e "$vault_dst" ]; then
    if [ "$UPDATE" -eq 1 ]; then
      # Show what would change, then ask. Anything you'd lose is in the diff.
      if diff -qr "$vault_dst" "$src_path" >/dev/null 2>&1; then
        skipped=$((skipped + 1))
        continue
      fi
      echo
      echo "=== diff for $name (vault vs share/skills/) ==="
      diff -ruN "$vault_dst" "$src_path" || true
      echo
      printf "Overwrite vault copy of %s? [y/N] " "$name"
      read -r reply
      if [ "$reply" = "y" ] || [ "$reply" = "Y" ]; then
        rm -rf "$vault_dst"
        cp -R "$src_path" "$vault_dst"
        echo "updated $name in vault"
        updated=$((updated + 1))
      else
        echo "kept $name (vault copy untouched)"
        skipped=$((skipped + 1))
      fi
    else
      skipped=$((skipped + 1))
    fi
  else
    cp -R "$src_path" "$vault_dst"
    echo "installed $name in vault"
    copied=$((copied + 1))
  fi

  # 2. Symlink the vault copy back into .claude/skills/.
  if [ -L "$repo_dst" ]; then
    current="$(readlink "$repo_dst")"
    if [ "$current" != "$vault_dst" ]; then
      ln -sfn "$vault_dst" "$repo_dst"
      echo "relinked .claude/skills/$name -> $vault_dst"
      relinked=$((relinked + 1))
    fi
  elif [ -e "$repo_dst" ]; then
    echo "SKIP $name (real dir at $repo_dst; not overwriting)" >&2
  else
    ln -s "$vault_dst" "$repo_dst"
    echo "linked .claude/skills/$name -> $vault_dst"
    linked=$((linked + 1))
  fi
done

echo "done: copied $copied, updated $updated, linked $linked, relinked $relinked"
if [ "$UPDATE" -eq 0 ] && [ "$skipped" -gt 0 ]; then
  echo "(re-run with --update to overwrite vault copies with share/skills/)"
fi
