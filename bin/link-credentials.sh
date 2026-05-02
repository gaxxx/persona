#!/bin/bash
# Symlink each entry in credentials/ to $HOME so tools that look for
# ~/.gmail-mcp, ~/.config/foo, etc. find them. Idempotent - re-run after
# adding new credential dirs.
#
# Layout:
#   credentials/.gmail-mcp/         -> ~/.gmail-mcp
#   credentials/.config-something/  -> ~/.config-something
#
# Symlinks (not copies) so OAuth refresh-token rewrites land in the
# single source of truth and key rotation propagates automatically.

set -euo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
CREDS="$REPO_ROOT/credentials"

if [ ! -d "$CREDS" ]; then
  echo "no credentials/ dir at $CREDS - nothing to link"
  exit 0
fi

linked=0
skipped=0
for entry in "$CREDS"/.* "$CREDS"/*; do
  [ -e "$entry" ] || continue
  name="$(basename "$entry")"
  case "$name" in . | .. ) continue ;; esac

  target="$HOME/$name"
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$entry" ]; then
    skipped=$((skipped+1))
    continue
  fi
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "WARN: $target exists and is not a symlink - skipping"
    continue
  fi
  ln -sfn "$entry" "$target"
  echo "linked $target -> $entry"
  linked=$((linked+1))
done

echo "done: $linked linked, $skipped already in place"
