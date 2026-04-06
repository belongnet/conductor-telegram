#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.conductor-telegram"
PID_FILE="$STATE_DIR/bot.pid"
LOG_FILE="$STATE_DIR/bot.log"

mkdir -p "$STATE_DIR"

# Check if already running
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Bot already running (PID $OLD_PID). Use scripts/stop-bot.sh first."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

# Load .env into environment
ENV_ARGS=""
if [ -f "$DIR/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
    export "$line"
  done < "$DIR/.env"
fi

# Build if needed
if [ ! -d "$DIR/dist" ]; then
  echo "Building..."
  cd "$DIR" && npm run build
fi

# Start bot in background
echo "Starting bot (logging to $LOG_FILE)..."
cd "$DIR"
BOT_TOKEN="$BOT_TOKEN" OWNER_CHAT_ID="$OWNER_CHAT_ID" nohup node dist/bot/index.js >> "$LOG_FILE" 2>&1 &
BOT_PID=$!
echo "$BOT_PID" > "$PID_FILE"
echo "Bot started (PID $BOT_PID)"
