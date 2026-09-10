import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import {getDb, closeDb} from "../src/store/db.js";
import {createWorkspace, createDecision, linkTelegramMessage, upsertRepoTopic, upsertThreadCursor} from "../src/store/queries.js";
import {GatewayStore} from "../src/cloud/store.js";

test("backup and migration preserve history, topics, decisions, cursors, pending updates, and file bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ct-migration-"));
  try {
    closeDb(); const dbPath = path.join(root, "state.db"); const db = getDb(dbPath); const store = new GatewayStore(db);
    const ws = createWorkspace({name: "history", prompt: "task", repoPath: "/Users/legacy/repos/repo", telegramChatId: "42"});
    createDecision(ws.id, "Proceed?", ["Yes", "No"]); linkTelegramMessage("42", "100", ws.id, "session");
    upsertThreadCursor({workspaceId: ws.id, sessionId: "session", backendKind: "cloud-api", lastForwardedRowid: 140, lastMessageId: "native-message"});
    upsertRepoTopic({chatId: "42", repoPath: "/Users/legacy/repos/repo", repoName: "repo", telegramThreadId: 7});
    store.ingest([{update_id: 7, message: {chat: {id: 42}, text: "queued since cutover"}}]);
    store.enqueue("cloud", ws.id, {trackedId: ws.id, type: "send", prompt: "pending operation"}, "pending");
    const files = path.join(root, "downloads"); mkdirSync(files); writeFileSync(path.join(files, "photo.jpg"), "image bytes");
    const identities = path.join(root, "identities.json");
    writeFileSync(identities, JSON.stringify({repositories: [{path: "/Users/legacy/repos/repo", remote: "git@github.com:org/repo.git", verifiedBy: "git-remote"}], projects: [{id: "project-1", gitRemote: "https://github.com/org/repo"}]}));
    const snapshot = path.join(root, "snapshot"); const migrated = path.join(root, "migrated");
    const run = (...args: string[]) => execFileSync("python3", ["scripts/cloud/state.py", ...args], {encoding: "utf8"});
    run("backup", "--db", dbPath, "--files", files, "--out", snapshot);
    assert.match(run("verify", snapshot), /verified/);
    run("migrate", "--snapshot", snapshot, "--out", migrated, "--identities", identities);
    const target = new Database(path.join(migrated, "conductor-telegram.db"), {readonly: true});
    try {
      assert.equal((target.prepare("SELECT count(*) AS n FROM telegram_message_links").get() as any).n, 1);
      assert.equal((target.prepare("SELECT value FROM gateway_state WHERE key='telegram-offset'").get() as any).value, "8");
      assert.equal((target.prepare("SELECT value FROM gateway_state WHERE key='repo-topic-project:42:7'").get() as any).value, '"project-1"');
      assert.equal((target.prepare("SELECT state FROM gateway_queue WHERE id='pending'").get() as any).state, "pending");
      assert.equal((target.prepare("SELECT last_message_id FROM thread_cursors").get() as any).last_message_id, "native-message");
      assert.equal(readFileSync(path.join(migrated, "downloads/photo.jpg"), "utf8"), "image bytes");
      const report = JSON.parse(readFileSync(path.join(migrated, "migration-report.json"), "utf8"));
      assert.equal(report.cutoverReady, true); assert.equal(report.preservedTables.decisions.rows, 1);
      assert.throws(() => run("migrate", "--snapshot", snapshot, "--out", migrated), /Command failed/);
      writeFileSync(path.join(snapshot, "downloads/photo.jpg"), "corrupt");
      assert.throws(() => run("verify", snapshot), /Command failed/);
    } finally {target.close();}
  } finally {closeDb(); rmSync(root, {recursive: true, force: true});}
});
