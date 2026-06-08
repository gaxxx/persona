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

# Auto-load .env on host installs so daemons we spawn (and our own
# CHAT_ID lookup below) see the right vars regardless of how we were
# started. Skip in Docker — compose's env_file already loaded everything,
# and host .env would clobber the in-container VAULT_PATH=/vault.
if [ ! -f /.dockerenv ] && [ -f .env ]; then
  set -a; . ./.env; set +a
fi

# Self-wrap with a pseudoterminal if our session has no controlling TTY.
# claude-code 2.1.133 + Haiku 4.5 in stream-json mode exits per turn when the
# inner claude's session has no controlling TTY. Daemons spawned by this
# watchdog inherit our session's controlling TTY, so wrapping here covers
# them. The WATCHDOG_PTY_WRAPPED guard prevents infinite re-exec loops.
if [ "${WATCHDOG_PTY_WRAPPED:-0}" != "1" ] && [ "${1:-}" != "--once" ]; then
  my_tty=$(ps -o tty= -p $$ 2>/dev/null | tr -d ' ')
  if [ -z "$my_tty" ] || [ "$my_tty" = "?" ]; then
    export WATCHDOG_PTY_WRAPPED=1
    # `setsid` so the new session can claim its own controlling TTY.
    # `script` allocates the PTY and runs us as its child.
    exec setsid script -qfc "bash $0 $*" /tmp/watchdog.log < /dev/null > /dev/null 2>&1
  fi
fi

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
WATCHDOG_PIDFILE="$PIDDIR/watchdog.pid"
# Stuck-loop threshold. tg-daemon stamps the heartbeat at the top of each
# poll cycle (~25s) AND on every inner-claude stdout event, so any
# legitimate progress — long multi-tool turn, slow download — keeps it
# fresh. Only true silence ages it. 180s gives slack for pathological
# multi-MB downloads on slow links without false-positive-killing healthy
# turns. Silent kill+respawn when tripped — no Telegram alert.
HEARTBEAT_MAX_AGE="${HEARTBEAT_MAX_AGE:-180}"

log() { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] watchdog: $*" >&2; }

# Singleton lock — refuse to start if another watchdog is already alive.
# Without this, if `--once` mode and the persistent watchdog ever overlap
# (e.g. /assistant-loop racing with a second invocation, or a startup
# script that doesn't `pgrep` first), they'd both `sweep_orphans` and
# kill each other's daemons in a loop.
acquire_watchdog_lock() {
  if [ -f "$WATCHDOG_PIDFILE" ]; then
    local existing
    existing=$(cat "$WATCHDOG_PIDFILE" 2>/dev/null)
    if [ -n "$existing" ] && [ "$existing" != "$$" ] && kill -0 "$existing" 2>/dev/null; then
      if [ -r "/proc/$existing/cmdline" ]; then
        tr '\0' ' ' < "/proc/$existing/cmdline" | grep -qF "bin/watchdog.sh" \
          && { log "another watchdog already alive (pid=$existing); exiting"; exit 0; }
      else
        # No /proc (macOS); trust the kill -0 result.
        log "another watchdog already alive (pid=$existing); exiting"
        exit 0
      fi
    fi
  fi
  echo $$ > "$WATCHDOG_PIDFILE"
  trap 'rm -f "$WATCHDOG_PIDFILE"' EXIT
}

# List PIDs of all processes whose argv is exactly `bun run <script>` OR
# `bun run <abs-path>/<script>`. Exact match (not regex contains) so that
# bash wrappers whose argv embeds the script name in an `eval`/`-c` string
# don't false-positive. Handles both relative invocations (started by this
# watchdog from REPO_ROOT) and absolute invocations (started by ad-hoc
# `nohup bun run /workspace/bin/tg-daemon.ts` commands).
list_daemon_pids() {
  local script="$1" pid rest
  while read -r pid rest; do
    case "$rest" in
      "bun run $script") echo "$pid" ;;
      "bun run "*"/$script") echo "$pid" ;;
    esac
  done < <(ps -eo pid=,args=)
}

# Sweep orphan daemons before we own the lifecycle. Without this, a previous
# watchdog's daemons can survive as PPID=1 orphans (e.g., if old watchdog was
# pkilled but daemons stayed up via nohup+disown). This watchdog would then
# spawn duplicates that fight over Telegram getUpdates.
sweep_orphans() {
  local killed=0 script pid
  for script in bin/tg-daemon.ts bin/cron-daemon.ts; do
    while read -r pid; do
      [ -z "$pid" ] && continue
      log "sweeping orphan $script (pid=$pid)"
      kill "$pid" 2>/dev/null || true
      killed=1
    done < <(list_daemon_pids "$script")
  done
  [ "$killed" = 1 ] && sleep 1 || true
}

# Per-cycle duplicate killer. sweep_orphans only runs on startup, so if a
# duplicate daemon appears later (manual `nohup bun run bin/tg-daemon.ts`,
# leftover from a previous watchdog process that didn't clean up, etc.), the
# watchdog's is_alive check passes (pidfile PID is alive) and never notices
# the duplicates. The result: N daemons all polling Telegram → user gets N
# replies per message. Keep only the pidfile-tracked PID; kill the rest.
kill_duplicates() {
  local pidfile="$1" script="$2" tracked pid
  tracked=$(cat "$pidfile" 2>/dev/null)
  [ -n "$tracked" ] || return 0
  while read -r pid; do
    [ -z "$pid" ] && continue
    [ "$pid" = "$tracked" ] && continue
    log "killing duplicate $script (pid=$pid, tracked=$tracked)"
    kill "$pid" 2>/dev/null || true
  done < <(list_daemon_pids "$script")
}

# Skip the singleton + sweep when running `--once` (which is meant to be
# called *by* an existing supervisor for a one-shot health check).
if [ "${1:-}" != "--once" ]; then
  acquire_watchdog_lock
  sweep_orphans
fi

# Bridge MCP credential dirs from the persistent vault into $HOME so MCPs
# that hard-code ~/.foo-mcp (e.g. @gongrzhe/server-gmail-autoauth-mcp) find
# their auth on every container restart. ln -sfn is atomic + idempotent.
link_mcp_credentials() {
  local d
  for d in "$REPO_ROOT"/mcp-credentials/.*-mcp; do
    [ -d "$d" ] || continue
    ln -sfn "$d" "$HOME/$(basename "$d")"
  done
}

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
# instead of spawning a duplicate.
adopt_existing() {
  local pidfile="$1" script="$2" pid
  [ -f "$pidfile" ] && return 0
  pid=$(list_daemon_pids "$script" | head -n 1)
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
  # GNU coreutils (Linux/Docker) uses `-c %Y`; BSD stat (macOS) uses `-f %m`.
  # Try GNU first, fall back to BSD. Both print just the epoch seconds.
  mtime=$(stat -c %Y "$TG_HEARTBEAT" 2>/dev/null || stat -f %m "$TG_HEARTBEAT" 2>/dev/null)
  [ -n "$mtime" ] || return 1
  now=$(date +%s)
  age=$(( now - mtime ))
  [ "$age" -le "$HEARTBEAT_MAX_AGE" ]
}

check_once() {
  link_mcp_credentials
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
  kill_duplicates "$TG_PIDFILE" "bin/tg-daemon.ts"

  if ! is_alive "$CRON_PIDFILE" "bin/cron-daemon.ts"; then
    notify "⏰ cron-daemon was down, restarting"
    start_cron_daemon
  fi
  kill_duplicates "$CRON_PIDFILE" "bin/cron-daemon.ts"
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
