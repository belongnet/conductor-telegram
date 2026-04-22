/**
 * In-process supervision for the bot. Three jobs:
 *   1. Crash handlers: turn unhandledRejection / uncaughtException into a
 *      clean exit(1) so launchd restarts us rather than leaving a zombie.
 *   2. Supervised interval: wrap setInterval callbacks so a single thrown
 *      error cannot kill the poll loop silently.
 *   3. Heartbeat + self-watchdog: write a liveness row to SQLite every
 *      HEARTBEAT_MS. If the heartbeat hasn't advanced within WATCHDOG_MS
 *      (e.g. a logic bug froze our timer), exit(1) so launchd recycles us.
 *      Cannot catch a fully-blocked event loop — launchd KeepAlive is the
 *      backstop for that.
 */

import { recordExitReason, touchHeartbeat } from "../store/queries.js";
import { createLogger, type Logger } from "./logger.js";

export const HEARTBEAT_MS = 10_000;
export const WATCHDOG_STALE_MS = 60_000;
const WATCHDOG_CHECK_MS = 15_000;

const log = createLogger("supervisor");

let shuttingDown = false;
let fatalCleanup: (() => void) | null = null;

export function installCrashHandlers(onFatal: () => void): void {
  fatalCleanup = onFatal;

  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection:", reason);
    fail("unhandledRejection");
  });

  process.on("uncaughtException", (err) => {
    log.error("uncaughtException:", err);
    fail("uncaughtException");
  });

  const sigShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    try {
      recordExitReason(`signal:${signal}`);
    } catch (err) {
      log.error("recordExitReason failed:", err);
    }
    try {
      onFatal();
    } catch (err) {
      log.error("cleanup failed:", err);
    }
    process.exit(0);
  };

  process.once("SIGINT", () => sigShutdown("SIGINT"));
  process.once("SIGTERM", () => sigShutdown("SIGTERM"));
}

function fail(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    recordExitReason(reason);
  } catch (err) {
    log.error("recordExitReason failed:", err);
  }
  try {
    fatalCleanup?.();
  } catch (err) {
    log.error("cleanup failed:", err);
  }
  process.exit(1);
}

/**
 * Wrap a setInterval callback so that a synchronous throw or an awaited
 * rejection doesn't bubble up to unhandledRejection. The loop keeps running.
 * Returns the timer handle so the caller can clearInterval on shutdown.
 */
export function supervisedInterval(
  scope: string,
  fn: () => void | Promise<void>,
  intervalMs: number
): ReturnType<typeof setInterval> {
  const scoped = createLogger(scope);
  return setInterval(async () => {
    try {
      await fn();
    } catch (err) {
      scoped.error("loop error:", err);
    }
  }, intervalMs);
}

/**
 * Start the heartbeat + self-watchdog. The heartbeat updates SQLite every
 * HEARTBEAT_MS. The watchdog checks *in-memory* last-tick time (cheap, no DB
 * read) and exits the process if the heartbeat interval itself stopped
 * firing.
 */
export function startHeartbeat(): { stop: () => void } {
  let lastTick = Date.now();

  const beat = setInterval(() => {
    try {
      touchHeartbeat();
      lastTick = Date.now();
    } catch (err) {
      log.error("heartbeat write failed:", err);
    }
  }, HEARTBEAT_MS);

  const watchdog = setInterval(() => {
    const stale = Date.now() - lastTick;
    if (stale > WATCHDOG_STALE_MS) {
      log.error(`heartbeat stale ${Math.round(stale / 1000)}s — self-exiting for restart`);
      fail(`heartbeat-stale-${Math.round(stale / 1000)}s`);
    }
  }, WATCHDOG_CHECK_MS);

  return {
    stop: () => {
      clearInterval(beat);
      clearInterval(watchdog);
    },
  };
}

export function getLogger(scope: string): Logger {
  return createLogger(scope);
}
