import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb } from "../src/store/db.js";
import { formatAttachmentReference } from "../src/bot/launcher.js";
import { runStartupMaintenance } from "../src/store/maintenance.js";

test("attachment references use markdown syntax that inline media extractor understands", () => {
  assert.equal(
    formatAttachmentReference("/tmp/screenshot.png"),
    "![screenshot.png](/tmp/screenshot.png)"
  );
  assert.equal(
    formatAttachmentReference("/tmp/notes.pdf"),
    "[notes.pdf](/tmp/notes.pdf)"
  );
  assert.equal(
    formatAttachmentReference("/tmp/photo.heic"),
    "![photo.heic](/tmp/photo.heic)"
  );
});

test("startup maintenance prunes old events and archived message links", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ct-maintenance-"));
  try {
    const db = getDb(path.join(dir, "bot.db"));
    db.prepare(
      `INSERT INTO workspaces
        (id, name, prompt, status, repo_path, created_at, telegram_chat_id, archived_at)
       VALUES
        ('old-ws', 'old', 'old prompt', 'archived', '/repos/a', datetime('now', '-45 days'), '1', datetime('now', '-45 days')),
        ('new-ws', 'new', 'new prompt', 'running', '/repos/a', datetime('now'), '1', NULL)`
    ).run();
    db.prepare(
      `INSERT INTO events (workspace_id, type, payload, created_at)
       VALUES
        ('old-ws', 'status', '{}', datetime('now', '-45 days')),
        ('new-ws', 'status', '{}', datetime('now'))`
    ).run();
    db.prepare(
      `INSERT INTO telegram_message_links (chat_id, telegram_message_id, workspace_id, created_at)
       VALUES
        ('1', '10', 'old-ws', datetime('now', '-45 days')),
        ('1', '11', 'new-ws', datetime('now'))`
    ).run();

    const report = runStartupMaintenance();
    assert.equal(report.eventsDeleted, 1);
    assert.equal(report.linksDeleted, 1);
    const eventCount = db
      .prepare("SELECT COUNT(*) AS count FROM events")
      .get() as { count: number };
    const linkCount = db
      .prepare("SELECT COUNT(*) AS count FROM telegram_message_links")
      .get() as { count: number };
    assert.equal(eventCount.count, 1);
    assert.equal(linkCount.count, 1);
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
