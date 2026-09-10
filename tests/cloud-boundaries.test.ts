import test from "node:test";
import assert from "node:assert/strict";
import { getDb, closeDb } from "../src/store/db.js";
import { createWorkspace, updateWorkspaceConductorBinding, updateWorkspaceStatus,
  enqueuePendingCloudMessage, getPendingCloudMessages, persistPendingCloudLaunch,
  getPendingCloudLaunch, upsertThreadCursor, getThreadCursor } from "../src/store/queries.js";
import { GatewayStore, type CloudBinding } from "../src/cloud/store.js";
import { CloudEngine } from "../src/cloud/engine.js";
import type { FileBridge } from "../src/cloud/bridge.js";
import { CloudRouter } from "../src/cloud/router.js";
import { CloudCommands } from "../src/cloud/commands.js";
import { CloudGitHub } from "../src/cloud/catalog.js";
import { restoreLegacyOperations } from "../src/cloud/legacy.js";
import { processQueue } from "../src/cloud/telegram.js";
import { ConductorApiError, type ConductorApiClient } from "../src/integrations/conductor-api.js";

async function fixture(run: (f: ReturnType<typeof makeFixture>) => Promise<void>) {
  closeDb();
  const f = makeFixture();
  try { await run(f); } finally { closeDb(); }
}

function makeFixture() {
  const store = new GatewayStore(getDb(":memory:"));
  const ws = createWorkspace({name: "Task", prompt: "Original task", repoPath: "conductor-project:p1", telegramChatId: "42"});
  const binding: CloudBinding = {workspaceId: "w1", projectId: "p1", repoUrl: "https://github.com/org/repo", repoSlug: "org/repo",
    branch: null, prUrl: null, sessionId: "s1", agent: "claude", model: "model", effort: "high", stopped: false};
  store.bind(ws.id, binding);
  updateWorkspaceConductorBinding(ws.id, {workspaceId: "w1", sessionId: "s1", backendKind: "cloud-api"});
  updateWorkspaceStatus(ws.id, "running");
  const messages: any[] = [];
  const sends: any[] = [];
  const api = {
    listProjects: async () => [{id: "p1", name: "conductor-telegram", gitRemote: binding.repoUrl}],
    listProjectWorkspaces: async (): Promise<any[]> => [],
    createWorkspace: async (_input: any): Promise<any> => ({workspaceId: "router-workspace", sessionId: "router-session"}),
    getWorkspaceStatus: async () => ({workspaceId: "w1", status: "ready"}),
    getSessionStatus: async (id: string) => ({workspaceId: "w1", sessionId: id, status: "idle"}),
    listWorkspaceSessions: async () => [{id: "s1", name: "Task"}],
    getMessage: async (id: string) => {
      const message = messages.find(m => m.id === id);
      if (!message) throw new ConductorApiError("Not found", 404);
      return message;
    },
    sendMessage: async (input: any) => {
      sends.push(input);
      messages.push({id: input.messageId, sessionId: input.sessionId, type: "user", content: input.message, sessionIndex: messages.length, receivedAt: new Date().toISOString()});
      return {messageId: input.messageId, state: "sent"};
    },
    listSessionMessages: async (_input: any): Promise<any[]> => messages.filter(m => m.type === "assistant"),
  };
  const bridge = {refreshQueuedLinks: () => {}} as unknown as FileBridge;
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, bridge, new CloudGitHub("unused"));
  store.set("router-binding", {workspaceId: "router-workspace", sessionId: "router-session"});
  const router = new CloudRouter(engine, "p1");
  const routeRow = () => {
    store.enqueue("route", "router", {text: "Keep\n  the original request", chatId: "42"}, "route-job");
    return store.row("route-job")!;
  };
  return {store, ws, binding, engine, api, messages, sends, router, routeRow};
}

test("cloud group commands ignore other bot mentions before routing or answering questions", () => fixture(async f => {
  f.store.set("telegram-bot-username", "GatewayBot");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "-42", "9");
  for (const [index, text] of ["/run@OtherBot p1 do work", "/ping@OtherBot", "/answer@OtherBot 1 yes"].entries()) {
    const id = index + 100;
    f.store.ingest([{update_id: id, message: {message_id: id, chat: {id: -42}, from: {id: 9}, message_thread_id: 7, text}}]);
    await processQueue(f.store, ["update", "health-update"], row => commands.handle(row));
  }
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind NOT IN ('update','health-update')").get() as any).n, 0);
}));

test("cloud commands accept their own mention case-insensitively and preserve arguments", () => fixture(async f => {
  f.store.set("telegram-bot-username", "GatewayBot");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "-42", "9");
  f.store.ingest([{update_id: 100, message: {message_id: 100, chat: {id: -42}, from: {id: 9}, message_thread_id: 7,
    text: "/run@gAtEwAyBoT p1 Keep the exact task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action = JSON.parse(f.store.row("update:100:action")!.payload);
  assert.equal(action.projectId, "p1");
  assert.equal(action.prompt, "Keep the exact task");
  assert.equal(JSON.parse(f.store.row("update:100:reply:0")!.payload).payload.message_thread_id, 7);
}));

test("cloud addressed commands fail closed until bot identity is available", () => fixture(async f => {
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{update_id: 100, message: {message_id: 100, chat: {id: 42}, from: {id: 9}, text: "/run@UnknownBot p1 work"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:100:action"), undefined);
}));

test("native routing preserves the request and requires owner confirmation, with duplicate callbacks deduplicated", () => fixture(async f => {
  const row = f.routeRow();
  await f.router.route(row);
  f.messages.push({type: "assistant", content: JSON.stringify({action: "existing", workspaceId: f.ws.id, prompt: "Model rewrote the request"})});
  await f.router.route(row);
  const confirmation = f.store.row("route-job:confirm:0");
  assert.ok(confirmation, "a valid raw JSON assistant reply must produce a confirmation");
  const key = JSON.parse(confirmation.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  for (const [id, user] of [[1, 10], [2, 9], [3, 9]]) {
    f.store.ingest([{update_id: id, callback_query: {id: `cb-${id}`, data: key, from: {id: user}, message: {chat: {id: 42}}}}]);
    await processQueue(f.store, ["update"], r => commands.handle(r));
    if (user === 10) assert.equal(f.store.row(`${key}:confirmed:action`), undefined);
  }
  const actions = f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='cloud'").all() as any[];
  assert.equal(actions.length, 1);
  assert.equal(JSON.parse(actions[0].payload).prompt, "Keep\n  the original request");
  assert.equal(f.sends.length, 1, "only the classifier prompt was sent");
}));

test("native router rejects unknown project IDs and workspaces from another chat", () => fixture(async f => {
  const foreign = createWorkspace({name: "Other chat", prompt: "private", repoPath: "x", telegramChatId: "99"});
  f.store.bind(foreign.id, f.binding);
  const row = f.routeRow(); await f.router.route(row);
  for (const result of [{action: "new", projectId: "invented", prompt: "work"}, {action: "existing", workspaceId: foreign.id, prompt: "work"}]) {
    f.messages.push({type: "assistant", content: JSON.stringify(result)});
    await assert.rejects(f.router.route(row), /unknown project|outside this chat/);
  }
  assert.equal(f.store.row("route-job:confirm:0"), undefined);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
}));

test("native router reconciles a lost send receipt using the same message ID and exact bytes", () => fixture(async f => {
  const send = f.api.sendMessage;
  f.api.sendMessage = async input => {await send(input); throw new Error("lost response");};
  const row = f.routeRow();
  await assert.rejects(f.router.route(row), /lost response/);
  await f.router.route(row);
  assert.equal(f.sends.length, 1);
  assert.ok(f.store.get("router-sent:route-job"));
  assert.equal(f.store.row("route-job:confirm:0"), undefined);
}));

test("native routing uses the transcript row ID when submission IDs differ", () => fixture(async f => {
  f.api.sendMessage = async input => {
    f.sends.push(input);
    f.messages.push({id: "transcript-command", sessionId: input.sessionId, type: "userMessage", sessionIndex: 1,
      content: {id: input.messageId, message: input.message, turnId: input.messageId}, receivedAt: new Date().toISOString()});
    return {messageId: input.messageId, state: "sent"};
  };
  f.api.listSessionMessages = async input => {
    if (input.after && input.after !== "transcript-command") throw new ConductorApiError("Cursor message not found in this session", 404);
    return input.after ? f.messages.slice(1) : f.messages;
  };
  const row = f.routeRow();
  await f.router.route(row);
  f.messages.push({id: "native-answer", sessionId: "router-session", type: "agent", sessionIndex: 2,
    content: {rawPayload: {type: "assistant", message: {role: "assistant", content: [{type: "text",
      text: JSON.stringify({action: "existing", workspaceId: f.ws.id, prompt: "Keep the request"})}]}}}});
  // A restart may reconcile a completed reply long after the polling timeout.
  f.store.set("router-sent:route-job", {at: Date.now() - 180_000});
  await new CloudRouter(f.engine, "p1").route(row);
  assert.ok(f.store.row("route-job:confirm:0"));
  assert.equal(f.sends.length, 1);
}));

test("native router never recreates an uncertain workspace after a restart", () => fixture(async f => {
  f.store.db.prepare("DELETE FROM gateway_state WHERE key='router-binding'").run();
  let attempts = 0;
  f.api.createWorkspace = async () => {attempts++; throw new Error("lost creation response");};
  const row = f.routeRow();
  await assert.rejects(f.router.route(row), /lost creation response/);
  await assert.rejects(new CloudRouter(f.engine, "p1").route(row), /receipt uncertain/);
  assert.equal(attempts, 1);
}));

test("legacy message adoption preserves native identity and exact bytes across repeated restoration", () => fixture(async f => {
  enqueuePendingCloudMessage(f.ws.id, {requestId: "legacy-request", sessionId: "s1", messageId: "legacy-native-message",
    prompt: "Original\n  pending bytes", createdAt: new Date().toISOString()});
  restoreLegacyOperations(f.engine); restoreLegacyOperations(f.engine);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0], {sessionId: "s1", messageId: "legacy-native-message", message: "Original\n  pending bytes"});
  assert.equal(getPendingCloudMessages(f.ws.id).length, 0);
  assert.equal(f.store.row(`legacy-message:${f.ws.id}:legacy-request`)?.state, "done");
}));

test("unresolved legacy creation is retained and fences new task replay", () => fixture(async f => {
  assert.equal(persistPendingCloudLaunch(f.ws.id, {workspaceId: "uncertain-workspace", sessionId: "uncertain-session",
    prompt: "Do not duplicate", messageId: "uncertain-message", phase: "provisioned"}), true);
  restoreLegacyOperations(f.engine);
  assert.equal(f.store.get(`stop:${f.ws.id}`), true);
  assert.ok(getPendingCloudLaunch(f.ws.id));
  f.engine.queue("later-send", {type: "send", trackedId: f.ws.id, prompt: "Must wait"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sends.length, 0);
  assert.equal(f.store.row("later-send")?.state, "done");
}));

test("invalid transcript cursor reanchors through older pages without replaying already forwarded messages", () => fixture(async f => {
  upsertThreadCursor({workspaceId: f.ws.id, sessionId: "s1", backendKind: "cloud-api", lastForwardedRowid: 150, lastMessageId: "stale-message"});
  f.store.set("session:s1", {trackedId: f.ws.id, agent: "claude", model: "model", effort: "high", role: "task"});
  const calls: any[] = [];
  f.api.listSessionMessages = async input => {
    calls.push(input);
    if (input.after) throw new ConductorApiError("Cursor expired", 404);
    const count = input.offset === 0 ? 100 : 55;
    return Array.from({length: count}, (_, i) => ({id: `m${input.offset + i}`, sessionId: "s1", type: "assistant",
      content: `Reply ${input.offset + i}`, sessionIndex: input.offset + i, receivedAt: new Date().toISOString()}));
  };
  await f.engine.pollWorkspace(f.ws.id, f.binding);
  assert.equal(getThreadCursor(f.ws.id, "s1")?.lastForwardedRowid, 150);
  assert.equal(f.store.get("reanchor:s1"), 100);
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.binding);
  assert.deepEqual(calls.map(c => c.offset), [undefined, 0, 100]);
  assert.equal(getThreadCursor(f.ws.id, "s1")?.lastMessageId, "m154");
  assert.equal(f.store.get("reanchor:s1"), undefined);
  assert.deepEqual((f.store.db.prepare("SELECT id FROM gateway_queue WHERE id LIKE 'transcript:%' ORDER BY id").all() as any[]).map(r => r.id),
    [151, 152, 153, 154].map(i => `transcript:s1:m${i}:0`));
}));

test("GitHub PR inspection validates repository and commit identities and surfaces HTTP failure", async () => {
  let calls = 0; let status = 200;
  let payload: any = {html_url: "https://github.com/org/repo/pull/1", number: 1, head: {sha: "a".repeat(40), ref: "feature"}, base: {sha: "b".repeat(40)}, state: "open"};
  const github = new CloudGitHub("test-token", (async (url: any, options: any) => {
    calls++; assert.equal(url, "https://api.github.com/repos/org/repo/pulls/1");
    assert.equal(options.headers.Authorization, "Bearer test-token"); assert.equal(options.redirect, "error");
    return new Response(JSON.stringify(payload), {status});
  }) as typeof fetch);
  await assert.rejects(github.pr("org/repo", "https://github.com/other/repo/pull/1"), /another repository/);
  assert.equal(calls, 0);
  assert.equal((await github.pr("org/repo", payload.html_url)).head, "a".repeat(40));
  payload = {...payload, head: {...payload.head, sha: "not-a-commit"}};
  await assert.rejects(github.pr("org/repo", payload.html_url), /invalid PR commit identities/);
  status = 503;
  await assert.rejects(github.pr("org/repo", payload.html_url), /503/);
});
