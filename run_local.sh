#!/bin/bash
set -e
cd "$(dirname "$0")"
set -a; . ./.env; set +a
export PATH="$HOME/.bun/bin:$PATH"
exec claude --dangerously-skip-permissions /assistant-loop
