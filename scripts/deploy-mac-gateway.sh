#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$ROOT"

echo "Installing dependencies..."
npm ci

echo "Checking types..."
npm run typecheck

echo "Running tests..."
npm test

echo "Building package..."
npm run build

echo "Installing this checkout globally..."
npm install -g "$ROOT"

echo "Reinstalling launchd service from the global CLI..."
SERVICE_INSTALL_ARGS=()
if [ -n "${CONDUCTOR_TELEGRAM_DOPPLER_PROJECT:-}" ] || [ -n "${CONDUCTOR_TELEGRAM_DOPPLER_CONFIG:-}" ]; then
  if [ -z "${CONDUCTOR_TELEGRAM_DOPPLER_PROJECT:-}" ] || [ -z "${CONDUCTOR_TELEGRAM_DOPPLER_CONFIG:-}" ]; then
    echo "Both CONDUCTOR_TELEGRAM_DOPPLER_PROJECT and CONDUCTOR_TELEGRAM_DOPPLER_CONFIG are required together." >&2
    exit 1
  fi
  SERVICE_INSTALL_ARGS=(
    --doppler-project "$CONDUCTOR_TELEGRAM_DOPPLER_PROJECT"
    --doppler-config "$CONDUCTOR_TELEGRAM_DOPPLER_CONFIG"
  )
fi
conductor-telegram service install "${SERVICE_INSTALL_ARGS[@]}"

echo "Restarting launchd service..."
conductor-telegram service restart

echo "Running gateway diagnostics..."
conductor-telegram doctor --no-color

echo "Gateway status:"
conductor-telegram service status
