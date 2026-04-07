#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="$HOME/.conductor-telegram"
PID_FILE="$STATE_DIR/bot.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found. Bot may not be running."
  exit 0
fi

REF=$(cat "$PID_FILE")

if [[ "$REF" == screen:* ]]; then
  SESSION="${REF#screen:}"
  if screen -ls | grep -q "[.]$SESSION[[:space:]]"; then
    echo "Stopping bot (screen session $SESSION)..."
    screen -S "$SESSION" -X quit || true
    sleep 1
    echo "Bot stopped."
  else
    echo "Bot not running (stale screen session $SESSION)."
  fi
else
  PID="$REF"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping bot (PID $PID)..."
    kill "$PID"
    # Wait up to 5s for graceful shutdown
    for i in $(seq 1 10); do
      if ! kill -0 "$PID" 2>/dev/null; then
        break
      fi
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      echo "Force killing..."
      kill -9 "$PID"
    fi
    echo "Bot stopped."
  else
    echo "Bot not running (stale PID $PID)."
  fi
fi

rm -f "$PID_FILE"
