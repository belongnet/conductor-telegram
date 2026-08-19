#!/bin/bash
# Poll origin/main and redeploy the Mac gateway when it changes.
#
# Runs every minute as the net.belong.conductor-telegram.updater LaunchAgent.
# `conductor-telegram service install --with-updater` copies this file to
# ~/.conductor-telegram/bin/gateway-update.sh and points the agent at the
# copy, so a broken checkout can never take the updater down with it. The
# canonical deploy checkout lives outside any Conductor workspace and is
# created here on first run, which makes a fresh machine (or a wiped
# checkout) self-bootstrapping.
#
# Written for the bash 3.2 that macOS ships; CI syntax-checks it there.
set -euo pipefail

GATEWAY_HOME="${CONDUCTOR_TELEGRAM_GATEWAY_HOME:-$HOME/.conductor-telegram/gateway}"
REPO_DIR="$GATEWAY_HOME/repo"
REMOTE_URL="${CONDUCTOR_TELEGRAM_GATEWAY_REMOTE:-https://github.com/belongnet/conductor-telegram.git}"
BRANCH="${CONDUCTOR_TELEGRAM_GATEWAY_BRANCH:-main}"
LOCK_DIR="$GATEWAY_HOME/update.lock"
STATE_FILE="$GATEWAY_HOME/last-deploy"
# Also the plist's StandardOutPath (UPDATE_LOG in src/cli/service.ts) — the
# two must name the same file or the in-place cap below stops working.
UPDATE_LOG="${CONDUCTOR_TELEGRAM_GATEWAY_LOG:-$HOME/.conductor-telegram/update.log}"
CONFIG_JSON="$HOME/.conductor-telegram/config.json"
LOG_MAX_BYTES=5242880
LOG_KEEP_BYTES=1048576
FAIL_RETRY_SECONDS=1800
DEPLOY_TIMEOUT_SECONDS="${CONDUCTOR_TELEGRAM_GATEWAY_DEPLOY_TIMEOUT:-2400}"
LOCK_NOTE_SECONDS=1800
LOCK_STALE_MINUTES=60

# The deploy needs npm/node (Homebrew) and git. launchd sets a matching
# PATH, but keep manual runs from a bare shell working too.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

log() { echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"; }

# Prefer plutil (reads JSON, always present on macOS) so notifications still
# work when the node toolchain is exactly what broke; fall back to node for
# non-mac environments like CI.
read_config_value() {
  if command -v plutil >/dev/null 2>&1; then
    v=$(plutil -extract "$1" raw -o - "$CONFIG_JSON" 2>/dev/null) && [ -n "$v" ] && {
      echo "$v"
      return 0
    }
  fi
  node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = c[process.argv[2]];
    if (v) process.stdout.write(String(v));
  ' "$CONFIG_JSON" "$1" 2>/dev/null || true
}

# Best-effort Telegram note to the owner chat on deploy state changes. The
# gateway exists for remote oversight, so deploy outcomes should reach the
# same chat. Silent on any failure and when secrets live in Doppler.
notify() {
  [ -f "$CONFIG_JSON" ] || return 0
  # v0.4.x wrote the bot token as `token`; current versions write `botToken`.
  token=$(read_config_value botToken)
  [ -n "$token" ] || token=$(read_config_value token)
  chat=$(read_config_value ownerChatId)
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  # URL arrives via stdin config (-K -) so the token never appears in
  # ps-visible argv.
  printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
    curl -sS -m 10 -o /dev/null -K - \
      --data-urlencode "chat_id=${chat}" \
      --data-urlencode "text=$1" 2>/dev/null || true
}

mkdir -p "$GATEWAY_HOME"

# One deploy at a time. A deploy outlives the 60s tick interval, so later
# ticks must skip. kill -0 alone can be fooled by pid reuse, so a live pid
# only counts as a real holder when it still looks like deploy tooling.
if mkdir "$LOCK_DIR" 2>/dev/null; then
  echo $$ > "$LOCK_DIR/pid"
else
  lock_pid=$(cat "$LOCK_DIR/pid" 2>/dev/null || true)
  lock_live=0
  if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
    lock_cmd=$(ps -o command= -p "$lock_pid" 2>/dev/null || true)
    case "$lock_cmd" in
      *gateway-update*|*deploy-mac-gateway*|*npm*|*node*|*git*|*bash*) lock_live=1 ;;
    esac
  fi
  # Hard ceiling regardless of pid liveness: a reused pid that happens to be
  # deploy-shaped tooling must not honor a crash leftover forever. Anything
  # older than the deploy timeout plus slack cannot be a legitimate holder.
  lock_hard_stale_minutes=$(( (DEPLOY_TIMEOUT_SECONDS + 1800) / 60 ))
  if [ "$lock_live" = "1" ] && \
      [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +$lock_hard_stale_minutes 2>/dev/null)" ]; then
    log "lock is older than ${lock_hard_stale_minutes}m (pid ${lock_pid}) — treating as wedged"
    lock_live=0
  fi
  if [ "$lock_live" = "1" ]; then
    # Long-held locks are either a slow deploy or a wedge — say so in the
    # log instead of exiting silently forever.
    if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +$((LOCK_NOTE_SECONDS / 60)) 2>/dev/null)" ]; then
      log "deploy still holds the lock (pid ${lock_pid}) — investigate if this persists"
    fi
    exit 0
  fi
  # A pid-less lock is usually a holder that just mkdir'd and has not written
  # its pid yet — only treat it as a crash leftover once it is clearly old.
  if [ -z "$lock_pid" ] && [ -z "$(find "$LOCK_DIR" -maxdepth 0 -mmin +$LOCK_STALE_MINUTES 2>/dev/null)" ]; then
    exit 0
  fi
  log "removing stale lock (pid ${lock_pid:-unknown})"
  rm -rf "$LOCK_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    exit 0
  fi
  echo $$ > "$LOCK_DIR/pid"
  # Two ticks can race into this steal path; the loser's rm -rf can eat the
  # winner's fresh lock. Re-check ownership after a beat so at most one
  # survives.
  sleep 1
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
    exit 0
  fi
fi
trap 'rm -rf "$LOCK_DIR"' EXIT

# launchd appends our stdout to update.log forever; cap it in place so the
# open O_APPEND descriptor keeps working (no rotate-by-rename). Done under
# the lock so a skipped tick never rewrites the log under an active deploy.
if [ -f "$UPDATE_LOG" ]; then
  size=$(wc -c < "$UPDATE_LOG" | tr -d ' ')
  if [ "$size" -gt "$LOG_MAX_BYTES" ]; then
    tail -c "$LOG_KEEP_BYTES" "$UPDATE_LOG" > "$UPDATE_LOG.tmp" 2>/dev/null || true
    cat "$UPDATE_LOG.tmp" > "$UPDATE_LOG" 2>/dev/null || true
    rm -f "$UPDATE_LOG.tmp"
  fi
fi

# The checkout must be exactly $REPO_DIR (never a discovered ancestor repo —
# a plain dir plus a git-tracked $HOME would otherwise get reset --hard) and
# must still point at the expected remote.
repo_ok=0
if [ -d "$REPO_DIR/.git" ]; then
  actual_top=$( (cd "$REPO_DIR" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || true)
  expect_top=$( (cd "$REPO_DIR" 2>/dev/null && pwd -P) || true)
  actual_remote=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)
  if [ -n "$actual_top" ] && [ "$actual_top" = "$expect_top" ] && [ "$actual_remote" = "$REMOTE_URL" ]; then
    repo_ok=1
  fi
fi
if [ "$repo_ok" != "1" ]; then
  if [ -d "$REPO_DIR" ] && [ -n "$(ls -A "$REPO_DIR" 2>/dev/null)" ]; then
    log "gateway checkout at $REPO_DIR is not a valid clone of $REMOTE_URL — recloning"
  else
    log "no gateway checkout at $REPO_DIR — cloning $REMOTE_URL ($BRANCH)"
  fi
  rm -rf "$REPO_DIR"
  # Same transfer bounds as the fetch: a wedged clone would hold the lock and
  # (launchd never overlaps StartInterval jobs) silently stop all ticks.
  if ! git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
      clone --quiet --branch "$BRANCH" "$REMOTE_URL" "$REPO_DIR"; then
    log "clone failed — will retry on the next tick"
    exit 0
  fi
fi

# Bounded fetch so a wedged network never leaves the lock held for hours.
if ! git -C "$REPO_DIR" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 \
    fetch --quiet origin "$BRANCH"; then
  log "git fetch failed — will retry on the next tick"
  exit 0
fi

local_sha=$(git -C "$REPO_DIR" rev-parse HEAD)
remote_sha=$(git -C "$REPO_DIR" rev-parse "origin/$BRANCH")

last_sha=""
last_status=""
last_epoch=0
if [ -f "$STATE_FILE" ]; then
  read -r last_sha last_status last_epoch < "$STATE_FILE" || true
fi
case "$last_epoch" in
  ''|*[!0-9]*) last_epoch=0 ;;
esac

# Quiet exit only once this exact revision has deployed cleanly; a matching
# checkout that never finished a deploy (fresh clone, aborted run) still
# needs one.
if [ "$local_sha" = "$remote_sha" ] && [ "$last_status" = "ok" ] && [ "$last_sha" = "$remote_sha" ]; then
  exit 0
fi

now=$(date +%s)
if [ "$last_sha" = "$remote_sha" ] && [ "$last_status" = "fail" ]; then
  elapsed=$((now - last_epoch))
  if [ "$elapsed" -lt "$FAIL_RETRY_SECONDS" ]; then
    exit 0
  fi
  log "retrying failed deploy of ${remote_sha} after ${elapsed}s"
fi

# A branch tip that is not a descendant of the deployed revision means the
# history was rewritten (or force-pushed back to an older state). Deploying
# it would silently roll the gateway back, so refuse and say how to accept
# a deliberate rewrite.
if [ "$local_sha" != "$remote_sha" ] && \
    ! git -C "$REPO_DIR" merge-base --is-ancestor "$local_sha" "$remote_sha" 2>/dev/null; then
  log "refusing non-fast-forward update ${local_sha} -> ${remote_sha}; if this rewrite is intentional, run: rm -rf $REPO_DIR"
  echo "$remote_sha fail $now" > "$STATE_FILE"
  notify "conductor-telegram gateway: refused non-fast-forward update to ${remote_sha} (possible rollback). To accept a deliberate history rewrite: rm -rf $REPO_DIR"
  exit 1
fi

# Final ownership check: a slow racer in the steal path may have replaced
# the lock after our earlier re-check. Never start a deploy without holding
# the lock at this instant.
if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
  log "lost lock ownership before deploy — aborting tick"
  exit 0
fi

log "deploying ${local_sha} -> ${remote_sha}"
git -C "$REPO_DIR" reset --hard --quiet "$remote_sha"
git -C "$REPO_DIR" clean -fdq

# Deploys run with a hard timeout: kill the whole process group if wedged
# (npm hanging on network is the classic), otherwise the lock never frees.
# CONDUCTOR_TELEGRAM_UPDATER tells `service install`/`service restart` they
# are running under this agent (self-kill guard, operator-stop guard).
export CONDUCTOR_TELEGRAM_UPDATER=1
set -m
bash "$REPO_DIR/scripts/deploy-mac-gateway.sh" &
deploy_pid=$!
set +m
waited=0
while kill -0 "$deploy_pid" 2>/dev/null; do
  if [ "$waited" -ge "$DEPLOY_TIMEOUT_SECONDS" ]; then
    log "deploy timed out after ${waited}s — killing process group ${deploy_pid}"
    kill -TERM -- "-$deploy_pid" 2>/dev/null || true
    grace=0
    while kill -0 "$deploy_pid" 2>/dev/null && [ "$grace" -lt 10 ]; do
      sleep 1
      grace=$((grace + 1))
    done
    # Unconditional group KILL: the leader dying on TERM says nothing about
    # descendants that trap it; KILLing an empty group is harmless.
    kill -KILL -- "-$deploy_pid" 2>/dev/null || true
    break
  fi
  sleep 5
  waited=$((waited + 5))
done
if wait "$deploy_pid" 2>/dev/null; then
  deploy_code=0
else
  deploy_code=$?
fi

version=$(cat "$REPO_DIR/VERSION" 2>/dev/null | tr -d '[:space:]' || true)
if [ "$deploy_code" = "0" ]; then
  echo "$remote_sha ok $now" > "$STATE_FILE"
  log "deploy of ${remote_sha} succeeded"
  notify "conductor-telegram gateway updated to v${version:-?} (${remote_sha})"
else
  echo "$remote_sha fail $now" > "$STATE_FILE"
  log "deploy of ${remote_sha} failed (exit $deploy_code) — next retry in ${FAIL_RETRY_SECONDS}s"
  notify "conductor-telegram gateway: deploy of ${remote_sha} FAILED (exit $deploy_code) — see ~/.conductor-telegram/update.log; retrying in $((FAIL_RETRY_SECONDS / 60))m"
  exit 1
fi
