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

# Install from a packed tarball, not the checkout: `npm install -g <folder>`
# symlinks the global install to the folder, which would make every later
# `git reset` / `npm ci` in this checkout mutate the LIVE gateway before the
# gates above have run. The tarball makes the global install a copy that
# only changes now, after typecheck/tests/build all passed.
echo "Packing release tarball..."
PACKED="$(npm pack --silent | tail -1)"
case "$PACKED" in
  *.tgz) ;;
  *)
    # An empty/odd pack result would turn the install below into a FOLDER
    # install — a global symlink to this mutable checkout, the exact hazard
    # the tarball exists to prevent.
    echo "npm pack produced no tarball (got: '$PACKED')" >&2
    exit 1
    ;;
esac
TARBALL="$ROOT/$PACKED"
if [ ! -f "$TARBALL" ]; then
  echo "npm pack tarball missing at $TARBALL" >&2
  exit 1
fi

echo "Installing packaged release globally..."
npm install -g "$TARBALL"
rm -f "$TARBALL"

# Drive the rest with the CLI we just installed, addressed absolutely via
# npm's own prefix. A PATH lookup could hit a stale shim from an older npm
# prefix and silently deploy old code forever.
GLOBAL_CLI="$(npm root -g)/conductor-telegram/dist/cli/index.js"
if [ ! -f "$GLOBAL_CLI" ]; then
  echo "Installed CLI not found at $GLOBAL_CLI" >&2
  exit 1
fi

echo "Reinstalling launchd service from the installed CLI..."
SERVICE_INSTALL_ARGS=()
# Enrollment in auto-deploys is opt-in. Only the updater agent (which sets
# CONDUCTOR_TELEGRAM_UPDATER=1) re-asserts it here; a manual run of this
# script deploys once without signing the machine up for continuous deploys.
if [ "${CONDUCTOR_TELEGRAM_UPDATER:-}" = "1" ]; then
  SERVICE_INSTALL_ARGS+=(--with-updater)
fi
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
# macOS ships bash 3.2, where `set -u` treats "${arr[@]}" on an empty array as
# an unbound variable. The `+` expansion keeps the no-flags case working.
node "$GLOBAL_CLI" service install ${SERVICE_INSTALL_ARGS[@]+"${SERVICE_INSTALL_ARGS[@]}"}

echo "Restarting launchd service..."
node "$GLOBAL_CLI" service restart

echo "Running gateway diagnostics..."
node "$GLOBAL_CLI" doctor --no-color

echo "Gateway status:"
node "$GLOBAL_CLI" service status
