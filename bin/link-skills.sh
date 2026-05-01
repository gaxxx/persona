#!/bin/bash
# Wire up the .claude/skills/ directory.
#
# Layout:
#   <repo>/.claude/skills/setup/         <- tracked. Ships with the clone so
#                                           /setup is available before any
#                                           vault is wired up.
#   <repo>/share/skills/<name>/          <- generic skill templates (assistant-loop,
#                                           assistant-test, kb). Get *copied* into
#                                           the vault on first run; you own the
#                                           copy and can edit freely.
#   <vault>/persona/.claude/skills/      <- holds your skills as real dirs:
#                                           personal skills you author, plus the
#                                           copies of share/skills/* installed
#                                           by this script.
#   <repo>/.claude/skills/<name>         <- per-skill symlink to the vault, for
#                                           every skill except setup.
#
# Idempotent. Run after `git clone`, after switching vaults, or with --update
# after pulling repo changes you want to apply to your vault copies.
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

mkdir -p "$VAULT_SKILLS"
mkdir -p "$REPO_SKILLS"

# 1. Copy each generic skill from share/skills/ into the vault (first run only,
#    or with --update). Existing real dirs in the vault are user-edited working
#    copies and stay put unless --update.
copied=0
updated=0
skipped_share=0
if [ -d "$SHARE" ]; then
  for src in "$SHARE"/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    dst="$VAULT_SKILLS/$name"
    if [ -L "$dst" ]; then
      # Stale symlink from an older layout - replace with a copy.
      rm "$dst"
      cp -R "${src%/}" "$dst"
      echo "migrated $name (symlink -> real copy)"
      copied=$((copied + 1))
    elif [ -e "$dst" ]; then
      if [ "$UPDATE" -eq 1 ]; then
        rm -rf "$dst"
        cp -R "${src%/}" "$dst"
        echo "updated $name (overwritten from share/skills/)"
        updated=$((updated + 1))
      else
        skipped_share=$((skipped_share + 1))
      fi
    else
      cp -R "${src%/}" "$dst"
      echo "installed $name"
      copied=$((copied + 1))
    fi
  done
fi

# 2. Symlink each vault skill into .claude/skills/. The 'setup' skill is the
#    one exception - it's a tracked real dir in the repo and must not be
#    shadowed.
linked=0
relinked=0
skipped_link=0
for src in "$VAULT_SKILLS"/*/; do
  [ -d "$src" ] || continue
  name="$(basename "$src")"
  if [ "$name" = "setup" ]; then
    # Don't shadow the tracked setup skill in the repo.
    skipped_link=$((skipped_link + 1))
    continue
  fi
  dst="$REPO_SKILLS/$name"
  target="${src%/}"
  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    if [ "$current" != "$target" ]; then
      ln -sfn "$target" "$dst"
      echo "relinked $name -> $target"
      relinked=$((relinked + 1))
    else
      skipped_link=$((skipped_link + 1))
    fi
  elif [ -e "$dst" ]; then
    echo "SKIP $name (real dir at $dst; not overwriting)" >&2
    skipped_link=$((skipped_link + 1))
  else
    ln -s "$target" "$dst"
    echo "linked $name -> $target"
    linked=$((linked + 1))
  fi
done

echo "done: copied $copied, updated $updated, linked $linked, relinked $relinked"
if [ "$UPDATE" -eq 0 ] && [ "$skipped_share" -gt 0 ]; then
  echo "(re-run with --update to overwrite vault copies with the share/skills/ version)"
fi
