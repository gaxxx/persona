#!/bin/bash
set -e
cd "$(dirname "$0")"

echo
echo "→ Attaching to tmux session (Ctrl-B D to detach):"
docker compose exec persona tmux a -t loop
