#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="$HOME/.conductor-telegram-sandbox"
PID_FILE="$STATE_DIR/bot.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No sandbox bot PID file found."
  exit 0
fi

PID=$(cat "$PID_FILE")
if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping sandbox bot (PID $PID)..."
  kill "$PID"
  rm -f "$PID_FILE"
  echo "Sandbox bot stopped."
else
  echo "Sandbox bot not running (stale PID $PID)."
  rm -f "$PID_FILE"
fi
