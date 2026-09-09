import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { GatewayStore } from "../src/cloud/store.js";

test("updates commit offset and bytes atomically and deduplicate replay", () => {
  const db = new Database(":memory:");
  try {
    const s = new GatewayStore(db);
    const update = { update_id: 8, message: { chat: { id: 1 }, message_thread_id: 2 } };
    s.ingest([update]); s.ingest([update]);
    assert.equal(s.get("telegram-offset"), 9);
    assert.equal(s.claim(["update"]).length, 1);
    assert.equal(s.claim(["update"]).length, 0);
  } finally { db.close(); }
});

test("conversation order survives retries while another topic progresses", () => {
  const db = new Database(":memory:");
  try {
    const s = new GatewayStore(db);
    s.enqueue("update", "a", {}, "first"); s.enqueue("update", "a", {}, "second");
    s.enqueue("update", "b", {}, "other");
    assert.deepEqual(s.claim(["update"]).map(x => x.id), ["first", "other"]);
    s.retry("first", "offline", 60_000);
    assert.equal(s.claim(["update"]).length, 0);
    s.finish("first");
    assert.deepEqual(s.claim(["update"]).map(x => x.id), ["second"]);
    const restarted = new GatewayStore(db); restarted.recover();
    assert.deepEqual(restarted.claim(["update"]).map(x => x.id).sort(), ["other", "second"]);
  } finally { db.close(); }
});

test("decision replies remain chat-scoped after restart", () => {
  const db = new Database(":memory:");
  try {
    new GatewayStore(db).linkDecision("a", 5, 44);
    const restarted = new GatewayStore(db);
    assert.equal(restarted.decisionForMessage("a", 5), 44);
    assert.equal(restarted.decisionForMessage("b", 5), undefined);
  } finally { db.close(); }
});
