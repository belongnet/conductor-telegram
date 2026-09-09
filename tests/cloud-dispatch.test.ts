import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { GatewayStore } from "../src/cloud/store.js";
import { QueueDispatcher } from "../src/cloud/telegram.js";

const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function latch() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return {waiting, release};
}

test("a stalled command leaves other conversations free while preserving its own order", async () => {
  const db = new Database(":memory:");
  const store = new GatewayStore(db);
  const blocked = latch();
  const handled: string[] = [];
  const worker = new QueueDispatcher(store, ["update"], async row => {
    if (row.id === "slow") await blocked.waiting;
    handled.push(row.id);
  });
  try {
    store.enqueue("update", "topic-a", {}, "slow");
    worker.tick(); await turn();
    store.enqueue("update", "topic-a", {}, "later-same-topic");
    store.enqueue("update", "topic-b", {}, "other-topic");
    worker.tick(); await turn();
    assert.deepEqual(handled, ["other-topic"]);
    assert.equal(store.row("slow")?.state, "running");
    assert.equal(store.row("later-same-topic")?.state, "pending");
    blocked.release(); await worker.settled();
    worker.tick(); await worker.settled();
    assert.deepEqual(handled, ["other-topic", "slow", "later-same-topic"]);
  } finally { blocked.release(); await worker.settled(); db.close(); }
});

test("native dispatch is bounded to four and starts pending work as each slot completes", async () => {
  const db = new Database(":memory:");
  const store = new GatewayStore(db);
  const gates = Array.from({length: 6}, latch);
  let active = 0, maximum = 0;
  const started: number[] = [];
  const worker = new QueueDispatcher(store, ["cloud"], async row => {
    const index = Number(row.id);
    active++; maximum = Math.max(maximum, active); started.push(index);
    await gates[index].waiting; active--;
  });
  try {
    for (let i = 0; i < 6; i++) store.enqueue("cloud", `workspace-${i}`, {}, String(i));
    worker.tick(); await turn(); worker.tick(); await turn();
    assert.deepEqual(started, [0, 1, 2, 3]);
    gates[1].release(); await turn();
    worker.tick(); await turn();
    assert.deepEqual(started, [0, 1, 2, 3, 4]);
    assert.equal(store.row("0")?.state, "running");
    assert.equal(maximum, 4);
  } finally { for (const gate of gates) gate.release(); await worker.settled(); db.close(); }
});

test("the health dispatcher remains responsive when all ordinary update workers are occupied", async () => {
  const db = new Database(":memory:");
  const store = new GatewayStore(db);
  const blocked = latch();
  const ordinary = new QueueDispatcher(store, ["update"], async () => blocked.waiting);
  let ping = false;
  const health = new QueueDispatcher(store, ["health-update"], async () => { ping = true; }, 1);
  try {
    for (let i = 0; i < 4; i++) store.enqueue("update", `chat:${i}`, {}, String(i));
    ordinary.tick(); await turn();
    store.ingest([{update_id: 100, message: {chat: {id: "chat"}, message_thread_id: 0, text: "/ping"}}]);
    health.tick(); await health.settled();
    assert.equal(ping, true);
    assert.equal(store.row("0")?.state, "running");
    assert.equal(store.row("update:100")?.state, "done");
  } finally { blocked.release(); await Promise.all([ordinary.settled(), health.settled()]); db.close(); }
});
