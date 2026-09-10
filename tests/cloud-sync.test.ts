import test from "node:test";
import assert from "node:assert/strict";
import {getDb, closeDb} from "../src/store/db.js";
import {getWorkspace, getThreadCursor, updateWorkspaceThreadId, linkTelegramMessage} from "../src/store/queries.js";
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
  assert.equal(f.store.get<any>("session:old")?.agent, "claude", "replies use the target session's model, not the default thread's model");
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
  assert.equal(media.action.sessionId, "old"); assert.equal(media.voice, true);
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
  assert.equal(nativeSessionProvider({id: "s", deepLink: "x", model: "grok-4.6"}).agent, "cursor");
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
  assert.equal(f.store.row("update:1:action")?.state, "pending");
  for (let i = 0; i < 3; i++) {
    assert.equal(f.store.row(`backlog:${i}:0`)?.state, "pending");
    f.store.set("telegram-chat-after:-42", 0); await sender.tick();
  }
  assert.deepEqual(texts.slice(1), ["Earlier transcript 0", "Earlier transcript 1", "Earlier transcript 2"]);
}));
