#!/bin/bash
# First-time local run after setup.sh. For subsequent restarts, use resume.sh.
set -e
cd "$(dirname "$0")"

[ -f .env ] || { echo "❌ .env not found — run setup.sh first"; exit 1; }
set -a; . ./.env; set +a
export PATH="$HOME/.bun/bin:$PATH"

# Dependencies
if [ ! -d node_modules ]; then
  echo "→ bun install"
  bun install
fi

PROVIDER="${PROVIDER:-oauth}"

# Auth
case "$PROVIDER" in
  oauth)
    echo "→ claude /login  (browser will open)"
    claude /login
    ;;
  apikey)
    echo "→ API key mode — skipping login"
    ;;
  router)
    echo "→ Router mode — skipping login"
    if ! pgrep -f "anthropic-router" > /dev/null 2>&1; then
      echo "  ⚠️  anthropic-router not running — watchdog will start it, or run bin/watchdog.sh manually"
    fi
    ;;
esac

echo
echo "→ Starting assistant loop"
exec claude --dangerously-skip-permissions /assistant-loop
