#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
STATE_DIR="$HOME/.conductor-telegram-sandbox"

echo "=== Conductor Telegram Sandbox Setup ==="

# 1. Install dependencies
echo "Installing dependencies..."
cd "$DIR" && npm install

# 2. Create .env.sandbox from example if it doesn't exist
if [ ! -f "$DIR/.env.sandbox" ]; then
  if [ -f "$DIR/.env.sandbox.example" ]; then
    cp "$DIR/.env.sandbox.example" "$DIR/.env.sandbox"
    echo "Created .env.sandbox from .env.sandbox.example"
    echo ""
    echo "ACTION REQUIRED: Edit .env.sandbox and fill in:"
    echo "  - BOT_TOKEN: Create a test bot via @BotFather on Telegram"
    echo "  - OWNER_CHAT_ID: Send /start to @userinfobot to get your chat ID"
  else
    echo "ERROR: .env.sandbox.example not found"
    exit 1
  fi
else
  echo ".env.sandbox already exists, skipping"
fi

# 3. Create state directory
mkdir -p "$STATE_DIR"
echo "State directory: $STATE_DIR"

# 4. Build
echo "Building..."
cd "$DIR" && npm run build

echo ""
echo "=== Setup complete ==="
echo "Run: scripts/run-sandbox-bot.sh"
