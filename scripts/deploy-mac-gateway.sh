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
conductor-telegram service install

echo "Restarting launchd service..."
conductor-telegram service restart

echo "Gateway status:"
conductor-telegram service status
