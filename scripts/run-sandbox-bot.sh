#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env.sandbox
if [ ! -f "$DIR/.env.sandbox" ]; then
  echo "ERROR: .env.sandbox not found. Run scripts/setup-sandbox.sh first."
  exit 1
fi

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^#.*$ || -z "$line" ]] && continue
  export "$line"
done < "$DIR/.env.sandbox"

# Rebuild if source is newer than dist
if [ ! -d "$DIR/dist" ] || [ "$(find "$DIR/src" -newer "$DIR/dist" -print -quit 2>/dev/null)" ]; then
  echo "Building..."
  cd "$DIR" && npm run build
fi

# Run in foreground so logs are visible in the workspace
echo "Starting sandbox bot (foreground)..."
cd "$DIR"
exec node dist/bot/index.js
