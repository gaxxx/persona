#!/bin/bash
# bin/entrypoint.sh — container startup.
#
# 1) Spawn the watchdog (it self-wraps with a PTY; daemons inherit it).
# 2) Exec into tmux + claude /assistant-loop for the interactive REPL.
#
# Decouples watchdog lifecycle from /assistant-loop, so daemons stay alive
# even if the inner claude REPL hangs / crashes / refuses to spawn things.

set -u
cd /workspace

# Start watchdog detached. watchdog.sh self-detects no controlling TTY and
# re-execs under `setsid script` so its descendants get a PTY (needed for
# claude-code 2.1.133 + Haiku 4.5 stream-json mode).
nohup bash bin/watchdog.sh > /tmp/watchdog-stdout.log 2>&1 &
disown

exec tmux new-session -A -s loop claude --dangerously-skip-permissions /assistant-loop
