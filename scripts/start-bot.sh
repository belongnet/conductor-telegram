#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.conductor-telegram"
PID_FILE="$STATE_DIR/bot.pid"
LOG_FILE="$STATE_DIR/bot.log"
SCREEN_NAME="conductor-telegram-bot"

mkdir -p "$STATE_DIR"

# Check if already running
if [ -f "$PID_FILE" ]; then
  OLD_REF=$(cat "$PID_FILE")
  if [[ "$OLD_REF" == screen:* ]]; then
    OLD_SESSION="${OLD_REF#screen:}"
    if screen -ls | grep -q "[.]$OLD_SESSION[[:space:]]"; then
      echo "Bot already running (screen session $OLD_SESSION). Use scripts/stop-bot.sh first."
      exit 1
    fi
  elif kill -0 "$OLD_REF" 2>/dev/null; then
    echo "Bot already running (PID $OLD_REF). Use scripts/stop-bot.sh first."
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

# Always build before starting so the running bot matches the workspace source.
echo "Building..."
cd "$DIR" && npm run build

# Start bot in background
echo "Starting bot (logging to $LOG_FILE)..."
cd "$DIR"
if command -v screen >/dev/null 2>&1; then
  if screen -ls | grep -q "[.]$SCREEN_NAME[[:space:]]"; then
    echo "Bot already running (screen session $SCREEN_NAME). Use scripts/stop-bot.sh first."
    exit 1
  fi

  screen -dmS "$SCREEN_NAME" zsh -lc "cd '$DIR' && BOT_TOKEN='$BOT_TOKEN' OWNER_CHAT_ID='$OWNER_CHAT_ID' exec node dist/bot/index.js >> '$LOG_FILE' 2>&1"
  sleep 1
  SCREEN_SESSION="$(screen -ls | awk '$1 ~ "\\." name "$" { print $1; exit }' name="$SCREEN_NAME")"
  if [ -z "$SCREEN_SESSION" ]; then
    echo "Failed to start bot in screen session."
    exit 1
  fi

  echo "screen:$SCREEN_SESSION" > "$PID_FILE"
  echo "Bot started (screen session $SCREEN_SESSION)"
else
  BOT_TOKEN="$BOT_TOKEN" OWNER_CHAT_ID="$OWNER_CHAT_ID" nohup node dist/bot/index.js >> "$LOG_FILE" 2>&1 &
  BOT_PID=$!
  echo "$BOT_PID" > "$PID_FILE"
  echo "Bot started (PID $BOT_PID)"
fi
