#!/bin/bash
# bin/watchdog.sh — supervises tg-daemon + cron-daemon. Spawned by
# /assistant-loop on REPL start (`& disown`) so it survives REPL exit.
#
# On daemon death:
#   1. Respawn it.
#   2. Telegram notification to the chat in $TELEGRAM_CHAT_ID (or .env).
#   3. If running inside Docker (presence of /.dockerenv), pkill claude
#      so the container's restart policy can give us a clean slate.
#
# Lifecycle:
#   - First REPL open:        /assistant-loop spawns this; it runs forever.
#   - REPL close:             watchdog continues (was disowned).
#   - Watchdog dies (rare):   next REPL open's /assistant-loop respawns it.
#   - In Docker:              container restart bootstraps everything.
#
# Manual test:   bash bin/watchdog.sh --once   # one cycle, then exit
# Manual stop:   pkill -f bin/watchdog.sh

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# TELEGRAM_CHAT_ID is expected in the env: Docker-compose pulls it in via
# env_file: .env; host installs export it before invoking. Empty just
# disables Telegram alerts — daemons still get respawned.
CHAT_ID="${TELEGRAM_CHAT_ID:-}"
INTERVAL="${WATCHDOG_INTERVAL:-60}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

IN_DOCKER=0
[ -f /.dockerenv ] && IN_DOCKER=1

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] watchdog: $*" >&2; }

notify() {
  local msg="$1"
  log "$msg"
  if [ -n "$CHAT_ID" ]; then
    bun run bin/tg-send.ts "$CHAT_ID" "$msg" 2>/dev/null || true
  fi
}

start_tg_daemon() {
  nohup bun run bin/tg-daemon.ts > /tmp/tg-daemon-stderr.log 2>&1 &
  disown
}

start_cron_daemon() {
  nohup bun run bin/cron-daemon.ts > /tmp/cron-daemon-stderr.log 2>&1 &
  disown
}

check_once() {
  if ! pgrep -f "bun.*tg-daemon\.ts" >/dev/null; then
    notify "🦌 tg-daemon was down, restarting"
    start_tg_daemon
    [ "$IN_DOCKER" = 1 ] && pkill -f '^claude' 2>/dev/null || true
  fi
  if ! pgrep -f "bun.*cron-daemon\.ts" >/dev/null; then
    notify "⏰ cron-daemon was down, restarting"
    start_cron_daemon
    [ "$IN_DOCKER" = 1 ] && pkill -f '^claude' 2>/dev/null || true
  fi
}

trap "log 'received SIGTERM, exiting'; exit 0" SIGTERM SIGINT

if [ "$ONCE" = 1 ]; then
  check_once
  exit 0
fi

log "starting (interval=${INTERVAL}s, in_docker=${IN_DOCKER})"
while true; do
  check_once
  sleep "$INTERVAL"
done
