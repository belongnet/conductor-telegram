import test from "node:test";
import assert from "node:assert/strict";
import {getDb, closeDb} from "../src/store/db.js";
import {getWorkspace, getWorkspaceMessageTarget, getThreadCursor, updateWorkspaceThreadId, linkTelegramMessage} from "../src/store/queries.js";
import {GatewayStore} from "../src/cloud/store.js";
import {CloudEngine} from "../src/cloud/engine.js";
import {CloudCommands} from "../src/cloud/commands.js";
import {CloudWorkspaceSync} from "../src/cloud/sync.js";
import {nativeSessionProvider} from "../src/cloud/messages.js";
import {CloudGitHub} from "../src/cloud/catalog.js";
import type {FileBridge} from "../src/cloud/bridge.js";
import {ConductorApiError, type ConductorApiClient} from "../src/integrations/conductor-api.js";
import {processQueue, enqueueText, TelegramDelivery} from "../src/cloud/telegram.js";

async function fixture(run: (f: ReturnType<typeof makeFixture>) => Promise<void>) {
  closeDb(); const f = makeFixture();
  try { await run(f); } finally { closeDb(); }
}
function makeFixture() {
  const store = new GatewayStore(getDb(":memory:"));
  const workspaces: any[] = [{id: "native-1", name: "Existing task", repoUrl: "https://github.com/org/repo", deepLink: "conductor://workspace?id=native-1", state: "ready"}];
  const sessions: any[] = [{id: "old", name: "Earlier", model: "fable-5-1"}, {id: "recent", name: "Current", model: "gpt-5.6-sol", effort: "max"}];
  const messages: any[] = [{id: "baseline", sessionId: "recent", sessionIndex: 4, type: "assistant", content: "Existing response", receivedAt: "2026-01-01T00:00:00Z"}];
  const sends: any[] = [];
  const api = {
    listProjects: async () => [{id: "project", name: "repo", gitRemote: "git@github.com:org/repo.git"}],
    listWorkspaces: async () => workspaces,
    listWorkspaceSessions: async () => sessions,
    getWorkspaceStatus: async () => ({workspaceId: "native-1", status: "ready"}),
    getSession: async (id: string) => sessions.find(s => s.id === id),
    getSessionStatus: async (id: string) => ({sessionId: id, workspaceId: "native-1", status: "idle", updatedAt: id === "recent" ? "2026-01-02T00:00:00Z" : "2026-01-01T00:00:00Z"}),
    getSessionMessageTail: async (id: string) => messages.filter(m => m.sessionId === id),
    getLatestSessionMessage: async (id: string) => messages.filter(m => m.sessionId === id).at(-1) ?? null,
    getMessage: async (id: string) => {const m = messages.find(m => m.id === id); if (!m) throw new ConductorApiError("Not found", 404); return m;},
    listSessionMessages: async ({sessionId, after}: any) => {const rows = messages.filter(m => m.sessionId === sessionId); return after ? rows.slice(rows.findIndex(m => m.id === after) + 1) : rows;},
    sendMessage: async (input: any) => {sends.push(input); return {messageId: input.messageId, state: "sent"};},
    createWorkspace: async () => {throw new Error("Discovery must not create native work");},
    cancelSession: async () => {throw new Error("Discovery must not stop native work");},
  };
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, {refreshQueuedLinks: () => {}} as unknown as FileBridge, new CloudGitHub("unused"));
  const sync = new CloudWorkspaceSync(engine, "-42");
  const commands = () => new CloudCommands(new GatewayStore(store.db), engine, async () => ({}), "42", "9", "-42");
  return {store, engine, sync, commands, api, workspaces, sessions, messages, sends};
}

test("discovery attaches one topic per native workspace without sending or replaying historical work", () => fixture(async f => {
  await f.sync.sync();
  const [{id, binding}] = f.store.bindings();
  assert.equal(binding.workspaceId, "native-1"); assert.equal(binding.projectId, "project");
  assert.equal(binding.sessionId, "recent"); assert.equal(binding.agent, "codex"); assert.equal(binding.effort, "max");
  assert.equal(getThreadCursor(id, "recent")?.lastMessageId, "baseline");
  assert.equal(getThreadCursor(id, "old")?.lastForwardedRowid, -1);
  assert.equal(f.store.get("session:recent"), undefined, "existing work is observed without initiating recovery");
  await new CloudWorkspaceSync(f.engine, "-42").sync();
  assert.equal(f.store.bindings().length, 1);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'create-topic:%'").get() as {n: number}).n, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(JSON.parse(f.store.row("sync-intro:native-1:0")!.payload).payload.disable_notification, true);
  assert.equal(JSON.parse(f.store.row("sync-snapshot:native-1:0")!.payload).payload.disable_notification, true);
}));

test("new messages in an initially empty native session forward and replies retain that exact session after restart", () => fixture(async f => {
  await f.sync.sync(); const [{id, binding}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.messages.push({id: "first-old", sessionId: "old", sessionIndex: 0, type: "assistant", content: "A new reply", receivedAt: new Date().toISOString()});
  await f.engine.pollWorkspace(id, binding);
  const row = f.store.row("transcript:old:first-old") ?? f.store.row("transcript:old:first-old:0");
  assert.ok(row);
  assert.equal(JSON.parse(row.payload).sessionId, "old");
  linkTelegramMessage("-42", "1000", id, "old");
  f.store.ingest([{update_id: 1, message: {message_id: 1001, chat: {id: -42}, from: {id: 9}, message_thread_id: 7,
    reply_to_message: {message_id: 1000}, text: "Continue this thread"}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].sessionId, "old");
  assert.match(f.sends[0].message, /^Continue this thread/);
  // A discovered workspace holds no bridge credential, so its agent answers inline instead of looking for MCP tools.
  assert.match(f.sends[0].message, /forwarded to Telegram/);
  assert.doesNotMatch(f.sends[0].message, /conductor-telegram-mcp|TELEGRAM_BRIDGE/);
  assert.equal(JSON.parse(f.store.row("update:1:action")!.payload).statusId, "update:1:reply:0");
  assert.equal(JSON.parse(f.store.row("update:1:action:sent")!.payload).method, "editMessageText");
  assert.equal(f.store.get<any>("session:old")?.agent, "claude", "replies use the target session's model, not the default thread's model");
}));

test("plain replies never use a discovered default when multiple native threads exist", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  // Discovery chose Codex. The user is looking at the Fable thread in Conductor.
  f.store.ingest([{update_id: 10, message: {message_id: 10, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, text: "go"}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sends.length, 0, "no prompt may reach the old default before a thread is chosen");
  const offer = JSON.parse(f.store.row("update:10:action:choose-thread:0")!.payload).payload;
  assert.match(offer.text, /choose.*thread/i);
  const buttons = offer.reply_markup.inline_keyboard.flat();
  const fable = buttons.find((b: any) => b.text.includes("fable-5-1"));
  assert.ok(fable, "same-named threads must be distinguishable by model");
  const click = (updateId: number, data: string) => {
    f.store.ingest([{update_id: updateId, callback_query: {id: String(updateId), from: {id: 9}, data,
      message: {message_id: 20, chat: {id: -42}, message_thread_id: 7}}}]);
    return processQueue(f.store, ["update"], row => f.commands().handle(row));
  };
  // New commands/store instances exercise persistence across restarts.
  await click(11, fable.callback_data);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].sessionId, "old");
  assert.match(f.sends[0].message, /^go\n/);
  assert.equal(f.store.binding(id)!.model, "fable-5-1");
  const receipt = JSON.parse(f.store.row("update:10:action:selected:sent")!.payload);
  assert.equal(receipt.method, "editMessageText");
  assert.equal(receipt.statusOf, "update:10:reply:0");
  assert.equal(receipt.sessionId, "old");
  assert.match(receipt.payload.text, /Earlier.*fable-5-1/);
  assert.match(receipt.payload.text, /workspace\?id=native-1&amp;session=old/);
  f.messages.push({id: f.sends[0].messageId, sessionId: "old", type: "user", content: f.sends[0].message});
  f.store.db.prepare("DELETE FROM gateway_queue WHERE id=?").run("update:10:action:selected:sent");
  f.store.retry("update:10:action:selected", "simulated restart after send state", 0);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.deepEqual(JSON.parse(f.store.row("update:10:action:selected:sent")!.payload), receipt,
    "a restart must restore the exact native thread receipt without resending");
  assert.equal(f.sends.length, 1);
  assert.equal(getWorkspaceMessageTarget("-42", "10")?.sessionId, "old", "replies to the user's own message retain its actual thread");
  await click(12, buttons.find((b: any) => b !== fable).callback_data);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  await f.engine.action(f.store.row("update:10:action")!);
  assert.equal(f.sends.length, 1, "a second choice must not replay work or change the selected thread");
  assert.equal(f.store.binding(id)!.sessionId, "old");
}));

async function tapThread(f: ReturnType<typeof makeFixture>, data: string, updateId = 50): Promise<void> {
  f.store.ingest([{update_id: updateId, callback_query: {id: String(updateId), from: {id: 9}, data,
    message: {message_id: 20, chat: {id: -42}, message_thread_id: 7}}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
}

test("explicit thread selection survives queue delays, model refresh and retries", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.store.ingest([{update_id: 1, message: {message_id: 1, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, text: "/threads"}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  const keyboard = JSON.parse(f.store.row("update:1:threads:0")!.payload).payload.reply_markup.inline_keyboard.flat();
  assert.ok(keyboard.every((b: any) => !b.text.startsWith("●")), "discovery is not an explicit selection");
  await tapThread(f, keyboard.find((b: any) => b.text.includes("fable")).callback_data);
  f.engine.queue("pinned", {type: "send", trackedId: id, prompt: "preserve me"});
  await tapThread(f, keyboard.find((b: any) => b.text.includes("gpt")).callback_data, 51);
  f.sessions[0].model = "fable-5-1-1m";
  f.sessions[0].deepLink = "conductor://workspace?id=native-1&session=old";
  const send = f.api.sendMessage;
  let attemptedSession: string | undefined;
  f.api.sendMessage = async input => {attemptedSession = input.sessionId; throw new ConductorApiError("Wait", 429);};
  await assert.rejects(f.engine.action(f.store.row("pinned")!), /Wait/);
  assert.equal(attemptedSession, "old");
  f.api.sendMessage = send;
  await f.engine.action(f.store.row("pinned")!);
  assert.equal(f.sends[0].sessionId, "old");
  assert.equal(f.store.get<any>("session:old").model, "fable-5-1-1m", "use current native model, never the stale binding or a global default");
  assert.equal(f.store.row("pinned:choose-thread:0"), undefined);
  assert.match(JSON.parse(f.store.row("pinned:sent:0")!.payload).payload.text, /workspace\?id=native-1&amp;session=old/);
}));

test("one visible native thread routes directly and a later thread does not redirect retries", () => fixture(async f => {
  f.sessions.splice(1);
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.engine.queue("single", {type: "send", trackedId: id, prompt: "one thread"});
  const send = f.api.sendMessage;
  f.api.sendMessage = async () => {throw new ConductorApiError("Wait", 429);};
  await assert.rejects(f.engine.action(f.store.row("single")!), /Wait/);
  assert.equal(JSON.parse(f.store.row("single")!.payload).sessionId, "old");
  f.sessions.push({id: "later", model: "gpt-6-astra"});
  f.store.bind(id, {...f.store.binding(id)!, sessionId: "later"});
  f.api.sendMessage = send;
  await f.engine.action(f.store.row("single")!);
  assert.equal(f.sends[0].sessionId, "old");
}));

test("pre-upgrade attempted sends without a frozen thread require reconciliation", () => fixture(async f => {
  await f.sync.sync(); const [{id, binding}] = f.store.bindings();
  f.engine.queue("uncertain", {type: "send", trackedId: id, prompt: "already attempted"});
  f.store.set("send-attempted:uncertain", true);
  await assert.rejects(f.engine.action(f.store.row("uncertain")!), /no recorded thread/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.row("uncertain:choose-thread:0"), undefined);
  assert.deepEqual(f.store.binding(id), binding);
}));

for (const selected of ["old", "recent"]) {
  test(`recovery only transfers Telegram selection when replacing its selected thread (${selected})`, () => fixture(async f => {
    await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
    f.store.bind(id, {...f.store.binding(id)!, sessionId: selected});
    f.store.set(`selected-thread:${id}`, selected);
    const status = f.api.getSessionStatus;
    f.api.getSessionStatus = async sid => ({...await status(sid), status: sid === "recent" ? "error" : "idle"});
    Object.assign(f.api, {createSession: async (input: any) => {
      const session = {id: "replacement", ...input}; f.sessions.push(session); return session;
    }});
    f.engine.queue("recover", {type: "thread", trackedId: id, prompt: "resume", recovery: true, previousSessionId: "recent"});
    await f.engine.action(f.store.row("recover")!);
    assert.equal(f.sends[0].sessionId, "replacement");
    assert.equal(f.store.get(`selected-thread:${id}`), selected === "recent" ? "replacement" : "old");
    f.engine.queue("next", {type: "send", trackedId: id, prompt: "next task"});
    await f.engine.action(f.store.row("next")!);
    if (selected === "recent") assert.equal(f.sends[1].sessionId, "replacement");
    else {
      assert.equal(f.sends.length, 1, "recovering another thread cannot silently redirect the next message");
      assert.ok(f.store.row("next:choose-thread:0"));
    }
  }));
}

test("a new thread command records its native target for replies after selection changes", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  Object.assign(f.api, {createSession: async (input: any) => {
    const session = {id: "new-thread", ...input}; f.sessions.push(session); return session;
  }});
  f.store.ingest([{update_id: 1, message: {message_id: 1, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, text: "/threads new task"}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(getWorkspaceMessageTarget("-42", "1")?.sessionId, "new-thread");
  f.store.bind(id, {...f.store.binding(id)!, sessionId: "old"}); f.store.set(`selected-thread:${id}`, "old");
  f.store.ingest([{update_id: 2, message: {message_id: 2, chat: {id: -42}, from: {id: 9}, message_thread_id: 7,
    text: "continue", reply_to_message: {message_id: 1}}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sends[1].sessionId, "new-thread");
}));

test("stop arriving during thread validation prevents selection and dispatch", () => fixture(async f => {
  await f.sync.sync(); const [{id, binding}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.engine.queue("choice", {type: "send", trackedId: id, prompt: "hold"});
  await f.engine.action(f.store.row("choice")!);
  const key = JSON.parse(f.store.row("choice:choose-thread:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  const status = f.api.getSessionStatus;
  f.api.getSessionStatus = async sid => {f.engine.queue("stop", {type: "stop", trackedId: id}); return status(sid);};
  await tapThread(f, key);
  assert.equal(f.store.row("choice:selected"), undefined);
  assert.equal(f.store.get(`selected-thread:${id}`), undefined);
  assert.deepEqual(f.store.binding(id), {...binding, stopped: true});
  assert.equal(f.sends.length, 0);
}));

test("thread choices preserve prepared attachments and cannot send after stop", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  Object.assign(f.engine.bridge, {file: () => ({name: "screenshot.png"}), link: () => "https://bridge.test/file"});
  f.engine.queue("attached", {type: "send", trackedId: id, prompt: "Read this\n  exact spacing", fileIds: ["image-1"]});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const keyboard = JSON.parse(f.store.row("attached:choose-thread:0")!.payload).payload.reply_markup.inline_keyboard.flat();
  await tapThread(f, keyboard[0].callback_data);
  assert.deepEqual(JSON.parse(f.store.row("attached:selected")!.payload).fileIds, ["image-1"]);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.match(f.sends[0].message, /^Read this\n  exact spacing\n/);
  assert.match(f.sends[0].message, /screenshot.png \(attachment ID image-1\): https:\/\/bridge.test\/file/);

  f.store.clear(`selected-thread:${id}`);
  f.engine.queue("stopped-choice", {type: "send", trackedId: id, prompt: "must not run"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const stopKey = JSON.parse(f.store.row("stopped-choice:choose-thread:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  f.engine.queue("stop", {type: "stop", trackedId: id});
  await tapThread(f, stopKey, 51);
  assert.equal(f.store.row("stopped-choice:selected"), undefined);
  assert.equal(f.sends.length, 1);
}));

test("media preparation retains the thread selected when the attachment arrived", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.store.bind(id, {...f.store.binding(id)!, sessionId: "old"});
  f.store.set(`selected-thread:${id}`, "old");
  Object.assign(f.engine.bridge, {save: () => "image-1", file: () => ({name: "photo.png"}), link: () => "https://bridge.test/file"});
  const previousFetch = globalThis.fetch, previousToken = process.env.BOT_TOKEN;
  globalThis.fetch = async () => new Response("image bytes");
  process.env.BOT_TOKEN = "test-placeholder";
  try {
    const commands = new CloudCommands(f.store, f.engine, async () => ({file_path: "photo.png", file_size: 11}), "42", "9", "-42");
    f.store.ingest([{update_id: 1, message: {message_id: 1, chat: {id: -42}, from: {id: 9}, message_thread_id: 7,
      caption: "inspect", document: {file_id: "photo", file_name: "photo.png"}}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    f.store.bind(id, {...f.store.binding(id)!, sessionId: "recent"});
    f.store.set(`selected-thread:${id}`, "recent");
    await processQueue(f.store, ["media"], row => commands.media(row));
    assert.equal(JSON.parse(f.store.row("update:1:action")!.payload).sessionId, "old");
    await processQueue(f.store, ["cloud"], row => f.engine.action(row));
    assert.equal(f.sends[0].sessionId, "old");
    assert.match(f.sends[0].message, /photo.png/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = previousToken;
  }
}));

test("stale and foreign thread buttons cannot rebind or dispatch the saved message", () => fixture(async f => {
  await f.sync.sync(); const [{id, binding}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.engine.queue("stale-choice", {type: "send", trackedId: id, prompt: "hold this"});
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  const key = JSON.parse(f.store.row("stale-choice:choose-thread:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  f.sessions[0].archivedAt = "2026-01-03T00:00:00Z";
  await tapThread(f, key);
  assert.equal(f.store.row("stale-choice:selected"), undefined);
  assert.equal(f.store.binding(id)!.sessionId, binding.sessionId);
  delete f.sessions[0].archivedAt;
  f.api.getSessionStatus = async sid => ({sessionId: sid, workspaceId: "foreign", status: "idle", updatedAt: "2026-01-03T00:00:00Z"});
  await tapThread(f, key, 51);
  assert.equal(f.store.row("stale-choice:selected"), undefined);
  assert.equal(f.store.binding(id)!.sessionId, binding.sessionId);
  assert.equal(f.sends.length, 0);
}));

test("sync group access is limited to the owner and explicitly synced topics; service events never become tasks", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  for (const [index, from, thread, extra] of [[1, 10, 7, {text: "intruder"}], [2, 9, 8, {text: "unrelated topic"}], [3, 9, 7, {forum_topic_closed: {}}]] as const) {
    f.store.ingest([{update_id: index, message: {message_id: index, chat: {id: -42}, from: {id: from}, message_thread_id: thread, ...extra}}]);
    await processQueue(f.store, ["update"], row => f.commands().handle(row));
    assert.equal(f.store.row(`update:${index}:action`), undefined);
  }
}));

test("sync voice replies reserve the correct session while transcription runs separately", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  linkTelegramMessage("-42", "1000", id, "old");
  f.store.ingest([{update_id: 1, message: {message_id: 1001, chat: {id: -42}, from: {id: 9}, message_thread_id: 7,
    reply_to_message: {message_id: 1000}, voice: {file_id: "voice-file"}}}]);
  await processQueue(f.store, ["update"], row => f.commands().handle(row));
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.sessionId, "old"); assert.equal(action.mediaPending, true);
  const media = JSON.parse(f.store.row("update:1:media")!.payload);
  assert.equal(media.action.sessionId, "old"); assert.equal(media.files[0].voice, true);
  assert.equal(f.sends.length, 0);
}));

test("ambiguous repository identities and unavailable sessions do not create guessed destinations", () => fixture(async f => {
  f.api.listProjects = async () => [{id: "a", name: "one", gitRemote: "https://github.com/org/repo"}, {id: "b", name: "two", gitRemote: "git@github.com:org/repo.git"}];
  await f.sync.sync(); assert.equal(f.store.bindings().length, 0);
  assert.equal(f.store.get<any>("cloud-sync-status")?.failures, 1);
  f.api.listProjects = async () => [{id: "a", name: "one", gitRemote: "https://github.com/org/repo"}];
  f.api.getSessionStatus = async () => {throw new ConductorApiError("Unavailable", 503);};
  await f.sync.sync(); assert.equal(f.store.bindings().length, 0);
}));

test("discovery skips its router, archived native work and stopped bindings", () => fixture(async f => {
  f.store.set("router-binding", {workspaceId: "native-1"}); await f.sync.sync(); assert.equal(f.store.bindings().length, 0);
  f.store.set("router-binding", null); f.workspaces[0].state = "archived"; await f.sync.sync(); assert.equal(f.store.bindings().length, 0);
  f.workspaces[0].state = "ready"; await f.sync.sync(); const [{id}] = f.store.bindings();
  f.store.set(`stop:${id}`, true); f.workspaces[0].name = "Changed externally";
  await f.sync.sync(); assert.equal(getWorkspace(id)?.name, "Existing task"); assert.equal(f.sends.length, 0);
}));

test("native rename cycles retain unique operations and archived work closes its topic without deleting history", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  for (const name of ["Renamed", "Existing task", "Renamed"]) {f.workspaces[0].name = name; await f.sync.sync();}
  assert.ok(f.store.row(`sync-rename:${id}:3`));
  f.workspaces.length = 0;
  f.api.getWorkspaceStatus = async () => ({workspaceId: "native-1", status: "archived"});
  await f.sync.sync(); assert.ok(getWorkspace(id)?.archivedAt);
  assert.equal(JSON.parse(f.store.row(`sync-close:${id}`)!.payload).method, "closeForumTopic");
  assert.equal(f.store.bindings().length, 1); assert.equal(getThreadCursor(id, "recent")?.lastMessageId, "baseline");
}));

test("native session provider resolution preserves exact models and rejects unknown providers", () => {
  assert.deepEqual(nativeSessionProvider({id: "s", deepLink: "x", model: "opus-5-1m", resolvedModel: "claude-opus-5[1m]", effort: "max"}), {agent: "claude", model: "opus-5-1m", effort: "max"});
  assert.equal(nativeSessionProvider({id: "s", deepLink: "x", model: "grok-4.7"}).agent, "cursor");
  assert.equal(nativeSessionProvider({id: "s", deepLink: "x", model: "grok-4.6"}).agent, "cursor");
  assert.equal(nativeSessionProvider({id: "s", deepLink: "x", model: "composer-2.5"}).agent, "cursor");
  assert.equal(nativeSessionProvider({id: "s", deepLink: "x", model: "deepseek-v3.2"}).agent, "cursor");
  assert.throws(() => nativeSessionProvider({id: "s", deepLink: "x", model: "unrecognized"}), /unsupported/);
});

test("a session created in Conductor after discovery forwards its very first reply", () => fixture(async f => {
  await f.sync.sync(); const [{id, binding}] = f.store.bindings();
  f.sessions.push({id: "new-thread", model: "gpt-5.6-sol"});
  f.messages.push({id: "new-first", sessionId: "new-thread", sessionIndex: 0, type: "assistant", content: "New native thread", receivedAt: new Date().toISOString()});
  await f.engine.pollWorkspace(id, binding);
  assert.ok(f.store.row("transcript:new-thread:new-first:0"));
  assert.equal(getThreadCursor(id, "new-thread")?.lastMessageId, "new-first");
}));

test("discovery includes workspaces beyond 100 and limits simultaneous workspace reads to four", () => fixture(async f => {
  f.workspaces.length = 0;
  for (let i = 0; i < 105; i++) f.workspaces.push({id: `native-${i}`, name: `Task ${i}`, repoUrl: "https://github.com/org/repo", deepLink: "conductor://test", state: "sleeping"});
  let active = 0, maximum = 0;
  f.api.listWorkspaceSessions = async (...args: any[]) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setImmediate(resolve)); active--;
    return [{id: args[0], name: "Task", model: "fable-5-1"}];
  };
  f.api.getSessionStatus = async id => ({workspaceId: id, sessionId: id, status: "idle", updatedAt: "2026-01-01T00:00:00Z"});
  f.api.getSessionMessageTail = async () => [];
  await f.sync.sync();
  assert.equal(f.store.bindings().length, 105); assert.equal(maximum, 4); assert.equal(f.sends.length, 0);
}));

test("migration group mode permits addressed commands but holds plain text and voice", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.store.set("telegram-bot-username", "GatewayBot");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9", "-42", "commands");
  for (const [index, payload] of [{text: "plain follow-up"}, {voice: {file_id: "voice"}}, {text: "/send@OtherBot ignore"}, {text: "/send@GatewayBot continue"}].entries()) {
    const uid=index+1;
    f.store.ingest([{update_id: uid, message: {message_id: uid, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, ...payload}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(!!f.store.row(`update:${uid}:action`), uid === 4);
    assert.equal(f.store.row(`update:${uid}:media`), undefined);
    if (uid <= 2) {
      const notice = JSON.parse(f.store.row(`update:${uid}:reply:0`)!.payload).payload.text;
      assert.match(notice, /awaiting cutover/i);
      assert.match(notice, /not sent to Conductor/i);
      assert.doesNotMatch(notice, /replies are waiting|during migration/i);
    }
  }
}));

test("an addressed command acknowledgement precedes queued transcripts without losing their order", () => fixture(async f => {
  await f.sync.sync(); const [{id}] = f.store.bindings(); updateWorkspaceThreadId(id, 7);
  f.store.db.prepare("UPDATE gateway_queue SET state='done' WHERE kind='telegram'").run();
  f.store.set("telegram-bot-username", "GatewayBot");
  for (let i = 0; i < 3; i++) enqueueText(f.store, `backlog:${i}`, "-42", `Earlier transcript ${i}`, {threadId: 7, workspaceId: id, sessionId: "old"});
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9", "-42", "commands");
  f.store.ingest([{update_id: 1, message: {message_id: 100, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, text: "/send@GatewayBot continue"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const texts: string[] = [];
  const sender = new TelegramDelivery(f.store, async (_method, payload) => {texts.push(payload.text); return {message_id: 200 + texts.length};});
  await sender.tick();
  assert.deepEqual(texts, ["Queued for Conductor."]);
  assert.equal(JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.disable_notification, true);
  assert.equal(f.store.row("update:1:action")?.state, "pending");
  for (let i = 0; i < 3; i++) {
    assert.equal(f.store.row(`backlog:${i}:0`)?.state, "pending");
    f.store.set("telegram-chat-after:-42", 0); await sender.tick();
  }
  assert.deepEqual(texts.slice(1), ["Earlier transcript 0", "Earlier transcript 1", "Earlier transcript 2"]);
}));
