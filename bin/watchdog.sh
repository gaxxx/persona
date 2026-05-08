#!/bin/bash
# bin/watchdog.sh — supervises tg-daemon + cron-daemon. Spawned by
# /assistant-loop on REPL start (`& disown`) so it survives REPL exit.
#
# Liveness is tracked via pidfiles in data/<name>.pid (written when we
# spawn). Checks use `kill -0 <pid>` plus a /proc/<pid>/cmdline sanity
# check, so ad-hoc shells whose argv mention the daemon names can't
# false-positive (the original `pgrep -f` approach hit exactly that bug).
#
# On daemon death:
#   1. Respawn it; record new PID in the pidfile.
#   2. Telegram notification to the chat in $TELEGRAM_CHAT_ID (or .env).
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

PIDDIR="$REPO_ROOT/data"
mkdir -p "$PIDDIR"
TG_PIDFILE="$PIDDIR/tg-daemon.pid"
CRON_PIDFILE="$PIDDIR/cron-daemon.pid"
TG_HEARTBEAT="$PIDDIR/tg-daemon-heartbeat"
# Stuck-loop threshold. tg-daemon stamps the heartbeat at the top of each
# poll cycle (~25s) AND on every inner-claude stdout event, so any
# legitimate progress — long multi-tool turn, slow download — keeps it
# fresh. Only true silence ages it. 180s gives slack for pathological
# multi-MB downloads on slow links without false-positive-killing healthy
# turns. Silent kill+respawn when tripped — no Telegram alert.
HEARTBEAT_MAX_AGE="${HEARTBEAT_MAX_AGE:-180}"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] watchdog: $*" >&2; }

# Sweep orphan daemons before we own the lifecycle. Without this, a previous
# watchdog's daemons can survive as PPID=1 orphans (e.g., if old watchdog was
# pkilled but daemons stayed up via nohup+disown). This watchdog would then
# spawn duplicates that fight over Telegram getUpdates.
sweep_orphans() {
  local killed=0
  for script in bin/tg-daemon.ts bin/cron-daemon.ts; do
    while read -r pid; do
      [ -z "$pid" ] && continue
      log "sweeping orphan $script (pid=$pid)"
      kill "$pid" 2>/dev/null || true
      killed=1
    done < <(ps -eo pid=,args= | awk -v s="$script" '$0 ~ ("[b]un run " s) {print $1}')
  done
  [ "$killed" = 1 ] && sleep 1 || true
}
sweep_orphans

notify() {
  local msg="$1"
  log "$msg"
  if [ -n "$CHAT_ID" ]; then
    printf '%s' "$msg" | bun run bin/tg-send.ts "$CHAT_ID" 2>/dev/null || true
  fi
}

# Liveness via pidfile. The cmdline check guards against PID reuse:
# if the daemon died and an unrelated process now holds the same PID,
# its cmdline won't contain the script path and we'll respawn.
is_alive() {
  local pidfile="$1" script="$2" pid
  [ -f "$pidfile" ] || return 1
  pid=$(cat "$pidfile" 2>/dev/null)
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [ -r "/proc/$pid/cmdline" ]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -qF -- "$script" || return 1
  fi
  return 0
}

# First-tick recovery: if a daemon is running but no pidfile exists
# (e.g., started manually before the watchdog came up), adopt its PID
# instead of spawning a duplicate. The [b]racket trick keeps the search
# command itself out of the match set.
adopt_existing() {
  local pidfile="$1" script="$2" pid
  [ -f "$pidfile" ] && return 0
  pid=$(ps -eo pid=,args= | awk -v s="$script" '$0 ~ ("[b]un run " s) {print $1; exit}')
  if [ -n "$pid" ]; then
    echo "$pid" > "$pidfile"
    log "adopted existing $script (pid=$pid)"
  fi
}

start_tg_daemon() {
  nohup bun run bin/tg-daemon.ts > /tmp/tg-daemon-stderr.log 2>&1 &
  echo $! > "$TG_PIDFILE"
  disown
}

start_cron_daemon() {
  nohup bun run bin/cron-daemon.ts > /tmp/cron-daemon-stderr.log 2>&1 &
  echo $! > "$CRON_PIDFILE"
  disown
}

is_heartbeat_fresh() {
  [ -f "$TG_HEARTBEAT" ] || return 1
  local mtime now age
  mtime=$(stat -c %Y "$TG_HEARTBEAT" 2>/dev/null) || return 1
  now=$(date +%s)
  age=$(( now - mtime ))
  [ "$age" -le "$HEARTBEAT_MAX_AGE" ]
}

check_once() {
  adopt_existing "$TG_PIDFILE" "bin/tg-daemon.ts"
  adopt_existing "$CRON_PIDFILE" "bin/cron-daemon.ts"

  if ! is_alive "$TG_PIDFILE" "bin/tg-daemon.ts"; then
    # Process actually died — operator should know.
    notify "🦌 tg-daemon was down, restarting"
    start_tg_daemon
  elif ! is_heartbeat_fresh; then
    # Process alive but loop wedged. Self-heal silently — no Telegram ping.
    local pid
    pid=$(cat "$TG_PIDFILE" 2>/dev/null)
    log "tg-daemon heartbeat stale (>${HEARTBEAT_MAX_AGE}s), silent respawn pid=$pid"
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
    sleep 2
    [ -n "$pid" ] && kill -9 "$pid" 2>/dev/null || true
    start_tg_daemon
  fi
  if ! is_alive "$CRON_PIDFILE" "bin/cron-daemon.ts"; then
    notify "⏰ cron-daemon was down, restarting"
    start_cron_daemon
  fi
}

trap "log 'received SIGTERM, exiting'; exit 0" SIGTERM SIGINT

if [ "$ONCE" = 1 ]; then
  check_once
  exit 0
fi

log "starting (interval=${INTERVAL}s)"
while true; do
  check_once
  sleep "$INTERVAL"
done
