#!/bin/bash
# Wire up the .claude/skills/ directory.
#
# Layout (vault is the source of truth, fully self-contained):
#   <vault>/persona/.claude/skills/      <- real dir; holds all your skills (real dirs)
#   <repo>/.claude/skills                <- symlink -> <vault>/persona/.claude/skills/
#   <repo>/share/skills/<name>/          <- generic skills shipped with the repo
#
# On first run, generic skills are *copied* into the vault (not symlinked) so
# you own your copy and can edit freely. Existing skills in the vault are
# left alone unless `--update` is passed (which forces a re-copy from share/).
#
# Idempotent. Run after `git clone`, after switching vaults, or with --update
# after pulling repo changes you want to apply to your vault.
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

# 2. Copy each shipped skill from share/skills/ into the vault (only if missing,
#    or if --update). Existing real dirs are treated as the user's working copy
#    and skipped. Stale symlinks (from the old layout) are replaced with copies.
copied=0
updated=0
skipped=0
if [ -d "$SHARE" ]; then
  for src in "$SHARE"/*/; do
    [ -d "$src" ] || continue
    name="$(basename "$src")"
    dst="$VAULT_SKILLS/$name"
    if [ -L "$dst" ]; then
      # Old symlink-back layout - replace with a copy.
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
        skipped=$((skipped + 1))
      fi
    else
      cp -R "${src%/}" "$dst"
      echo "installed $name"
      copied=$((copied + 1))
    fi
  done
fi

echo "done: copied $copied, updated $updated, skipped $skipped"
if [ "$UPDATE" -eq 0 ] && [ "$skipped" -gt 0 ]; then
  echo "(re-run with --update to overwrite skipped skills with the share/skills/ version)"
fi
