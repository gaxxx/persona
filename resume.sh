#!/bin/bash
set -a; . ./.env; set +a
# PATH is host-only and not in .env (env_file would leak the host PATH into the
# Docker container), so put bun on PATH here.
export PATH="$HOME/.bun/bin:$PATH"
exec claude --dangerously-skip-permissions
