import { getDb } from "./db.js";
import { createLogger } from "../bot/logger.js";

const log = createLogger("maintenance");

function envDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const EVENTS_RETENTION_DAYS = envDays("EVENTS_RETENTION_DAYS", 30);
const ARCHIVED_LINKS_RETENTION_DAYS = envDays("LINKS_RETENTION_DAYS", 30);
const VACUUM_INTERVAL_DAYS = envDays("VACUUM_INTERVAL_DAYS", 7);
const WAL_CHECKPOINT_INTERVAL_MS = 60 * 60 * 1000;

export interface MaintenanceReport {
  eventsDeleted: number;
  linksDeleted: number;
  vacuumed: boolean;
  walCheckpointed: boolean;
}

export function runStartupMaintenance(): MaintenanceReport {
  const report: MaintenanceReport = {
    eventsDeleted: 0,
    linksDeleted: 0,
    vacuumed: false,
    walCheckpointed: false,
  };

  try {
    report.eventsDeleted = deleteOldEvents();
  } catch (err) {
    log.error("events retention failed:", err);
  }

  try {
    report.linksDeleted = deleteArchivedLinks();
  } catch (err) {
    log.error("archived link cleanup failed:", err);
  }

  try {
    report.walCheckpointed = walCheckpoint();
  } catch (err) {
    log.error("WAL checkpoint failed:", err);
  }

  try {
    report.vacuumed = maybeVacuum();
  } catch (err) {
    log.error("VACUUM failed:", err);
  }

  log.info(
    `startup maintenance: events=${report.eventsDeleted} links=${report.linksDeleted} vacuum=${report.vacuumed} wal=${report.walCheckpointed}`
  );
  return report;
}

export function startMaintenanceTimer(): { stop: () => void } {
  const timer = setInterval(() => {
    try {
      walCheckpoint();
    } catch (err) {
      log.error("periodic WAL checkpoint failed:", err);
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  timer.unref?.();

  return {
    stop: () => {
      clearInterval(timer);
      try {
        walCheckpoint();
      } catch (err) {
        log.error("shutdown WAL checkpoint failed:", err);
      }
    },
  };
}

function deleteOldEvents(): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM events
       WHERE created_at < datetime('now', ?)`
    )
    .run(`-${EVENTS_RETENTION_DAYS} days`);
  return Number(result.changes);
}

function deleteArchivedLinks(): number {
  const db = getDb();
  const result = db
    .prepare(
      `DELETE FROM telegram_message_links
       WHERE workspace_id IN (
         SELECT id FROM workspaces
         WHERE archived_at IS NOT NULL
           AND archived_at < datetime('now', ?)
       )`
    )
    .run(`-${ARCHIVED_LINKS_RETENTION_DAYS} days`);
  return Number(result.changes);
}

function walCheckpoint(): boolean {
  const db = getDb();
  db.pragma("wal_checkpoint(TRUNCATE)");
  return true;
}

function maybeVacuum(): boolean {
  const db = getDb();
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'last_vacuum_at'")
    .get() as { value: string } | undefined;

  if (row) {
    const last = new Date(row.value).getTime();
    const ageMs = Date.now() - last;
    const intervalMs = VACUUM_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(last) && ageMs < intervalMs) return false;
  }

  db.exec("VACUUM");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO meta (key, value, updated_at)
     VALUES ('last_vacuum_at', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).run(now, now);
  return true;
}
