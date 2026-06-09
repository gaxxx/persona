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
# PATH is host-only and intentionally NOT in .env (env_file would inject the
# host's PATH into the container), so put bun on PATH here for spawned daemons.
if [ ! -f /.dockerenv ] && [ -f .env ]; then
  set -a; . ./.env; set +a
  export PATH="$HOME/.bun/bin:$PATH"
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
ROUTER_PIDFILE="$PIDDIR/router.pid"
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

# Sweep orphan daemons before we own the lifecycle. Without this, a previous
# watchdog's daemons can survive as PPID=1 orphans (e.g., if old watchdog was
# pkilled but daemons stayed up via nohup+disown). This watchdog would then
# spawn duplicates that fight over Telegram getUpdates.
sweep_orphans() {
  local killed=0
  for script in bin/tg-daemon.ts bin/cron-daemon.ts bin/anthropic-router.ts; do
    while read -r pid; do
      [ -z "$pid" ] && continue
      log "sweeping orphan $script (pid=$pid)"
      kill "$pid" 2>/dev/null || true
      killed=1
    done < <(ps -eo pid=,args= | awk -v s="$script" '$0 ~ ("[b]un run " s) {print $1}')
  done
  [ "$killed" = 1 ] && sleep 1 || true
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

# Singleton-guard kill, used before (re)spawning. We must NOT use
# `pkill -f "bin/<name>.ts"`: that substring also matches any `claude -p`
# whose *prompt text* mentions the daemon path (the assistant routinely
# discusses its own source), so a careless pkill could murder a live turn.
# Instead match the exact `bun run <script>` command we spawn — mirroring
# adopt_existing()'s [b]un-run anchoring — and additionally skip any
# process whose executable is `claude` and our own watchdog PID.
kill_daemon() {
  local script="$1" pid comm rest
  ps -eo pid=,comm=,args= | while read -r pid comm rest; do
    case " $rest " in
      *"bun run $script"*)
        [ "$comm" = "claude" ] && continue
        [ "$pid" = "$$" ] && continue
        kill "$pid" 2>/dev/null ;;
    esac
  done
  return 0
}

start_tg_daemon() {
  # `env -u TELEGRAM_CHAT_IDS`: in Docker, compose injects an *empty*
  # TELEGRAM_CHAT_IDS (compose line `${TELEGRAM_CHAT_IDS:-}`) into the
  # container env, and a set-but-empty var shadows the populated value in
  # .env (bun: real env > .env). Unsetting it here lets bun read the real
  # comma-separated list (Siyun + kids) from .env. Harmless on host / after
  # a clean recreation — bun then just reads the same value from .env.
  # Singleton guard: kill any pre-existing tg-daemon before spawning so a
  # watchdog *restart* (a fresh watchdog can't see the old watchdog's pidfile)
  # can never leave two daemons polling Telegram → duplicate replies.
  # kill_daemon() matches `bun run bin/tg-daemon.ts` exactly, so it won't
  # touch a cron `claude -p` that merely mentions the path in its prompt.
  kill_daemon "bin/tg-daemon.ts"; sleep 1
  nohup env -u TELEGRAM_CHAT_IDS bun run bin/tg-daemon.ts > /tmp/tg-daemon-stderr.log 2>&1 &
  echo $! > "$TG_PIDFILE"
  disown
}

start_cron_daemon() {
  # Singleton guard (see start_tg_daemon). Without this, a watchdog restart
  # leaves the old cron-daemon orphaned-but-alive → two daemons fire every
  # task twice (seen 2026-05-30: two daily-journals at 22:02 / 22:05 after the
  # 21:42 respawn). This is the kill-before-respawn step CRON.md prescribes.
  kill_daemon "bin/cron-daemon.ts"; sleep 1
  nohup bun run bin/cron-daemon.ts > /tmp/cron-daemon-stderr.log 2>&1 &
  echo $! > "$CRON_PIDFILE"
  disown
}

start_router() {
  kill_daemon "bin/anthropic-router.ts"; sleep 1
  nohup bun run bin/anthropic-router.ts > /tmp/router-stderr.log 2>&1 &
  echo $! > "$ROUTER_PIDFILE"
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
  adopt_existing "$ROUTER_PIDFILE" "bin/anthropic-router.ts"

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
  if ! is_alive "$ROUTER_PIDFILE" "bin/anthropic-router.ts"; then
    log "🔀 router was down, restarting"
    start_router
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
