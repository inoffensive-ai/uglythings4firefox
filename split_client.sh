#!/usr/bin/env bash
set -euo pipefail

SESSION="bridge_cli"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$SCRIPT_DIR/bridge_cli.py"
PORT="${1:-8767}"
HOST_ARG="${2:-}"

EXTRA_ARGS=()
if [[ -n "$HOST_ARG" ]]; then
  EXTRA_ARGS=(--host "$HOST_ARG")
fi

tmux new-session -d -s "$SESSION" \
  "python3 \"$CLI\" --mode send --port \"$PORT\" ${EXTRA_ARGS[*]-}"

tmux split-window -v -t "$SESSION:0.0" \
  "python3 \"$CLI\" --mode recv --port \"$PORT\" ${EXTRA_ARGS[*]-}"

tmux select-pane -t "$SESSION:0.0"
tmux attach-session -t "$SESSION"