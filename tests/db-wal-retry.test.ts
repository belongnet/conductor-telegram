import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { closeDb, enableWalWithRetry, getDb } from "../src/store/db.js";

function busyError(label: string): Error {
  const error = new Error(`database is locked (${label})`) as Error & {
    code?: string;
  };
  error.code = "SQLITE_BUSY";
  return error;
}

/**
 * enableWalWithRetry only ever issues two pragma shapes: the WAL switch and a
 * simple-mode read-back. The fake fails the switch a configurable number of
 * times so each contention outcome is reachable without a second process.
 */
function fakePragmaDb(behavior: {
  failuresBeforeSuccess: number;
  journalModeRead: () => unknown;
}): {
  db: Database.Database;
  setAttempts: () => number;
  modeReads: () => number;
  busyTimeout: () => number;
} {
  let setAttempts = 0;
  let modeReads = 0;
  let busyTimeout = 5000;
  const db = {
    pragma(sql: string, options?: { simple?: boolean }) {
      if (sql === "busy_timeout") {
        assert.equal(options?.simple, true);
        return busyTimeout;
      }
      const busyTimeoutWrite = sql.match(/^busy_timeout = (\d+)$/);
      if (busyTimeoutWrite) {
        busyTimeout = Number(busyTimeoutWrite[1]);
        return [{ busy_timeout: busyTimeout }];
      }
      if (sql === "journal_mode = WAL") {
        setAttempts += 1;
        if (setAttempts <= behavior.failuresBeforeSuccess) {
          throw busyError(`attempt ${setAttempts}`);
        }
        return [{ journal_mode: "wal" }];
      }
      assert.equal(sql, "journal_mode");
      assert.equal(options?.simple, true);
      modeReads += 1;
      return behavior.journalModeRead();
    },
  } as unknown as Database.Database;
  return {
    db,
    setAttempts: () => setAttempts,
    modeReads: () => modeReads,
    busyTimeout: () => busyTimeout,
  };
}

test("getDb switches a fresh database file to WAL journal mode", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-wal-retry-"));
  try {
    closeDb();
    const db = getDb(path.join(dir, "bot.db"));
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transient SQLITE_BUSY on the WAL switch is retried until it succeeds", () => {
  const fake = fakePragmaDb({
    failuresBeforeSuccess: 2,
    journalModeRead: () => "delete",
  });

  assert.doesNotThrow(() => enableWalWithRetry(fake.db, { retryMs: 1 }));
  assert.equal(fake.setAttempts(), 3);
  assert.equal(fake.modeReads(), 2);
  // The switch runs under a minimal in-SQLite wait, then the caller's
  // busy_timeout is restored.
  assert.equal(fake.busyTimeout(), 5000);
});

test("a database another process already switched to WAL is accepted", () => {
  const fake = fakePragmaDb({
    failuresBeforeSuccess: Number.POSITIVE_INFINITY,
    // The switch pragma keeps throwing, but the file already reads back
    // as WAL because a concurrent open won the race.
    journalModeRead: () => "wal",
  });

  assert.doesNotThrow(() => enableWalWithRetry(fake.db, { retryMs: 1 }));
  assert.equal(fake.setAttempts(), 1);
  assert.equal(fake.modeReads(), 1);
  assert.equal(fake.busyTimeout(), 5000);
});

test("persistent contention surfaces the final pragma error", () => {
  const fake = fakePragmaDb({
    failuresBeforeSuccess: Number.POSITIVE_INFINITY,
    journalModeRead: () => {
      // Reading the mode hits the same lock; the retry loop must keep going
      // and ultimately rethrow the last switch failure, not the read failure.
      throw busyError("mode read");
    },
  });

  assert.throws(
    () => enableWalWithRetry(fake.db, { retryMs: 1 }),
    /database is locked \(attempt 10\)/
  );
  assert.equal(fake.setAttempts(), 10);
  // Restoration happens even on the failure path.
  assert.equal(fake.busyTimeout(), 5000);
});
