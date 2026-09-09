import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getDb, closeDb } from "../src/store/db.js";
import { createWorkspace, getWorkspace, getDecision, answerDecision, getWorkspaceMessageTarget, getThreadCursor, updateWorkspaceThreadId } from "../src/store/queries.js";
import { GatewayStore } from "../src/cloud/store.js";
import { FileBridge, startBridge } from "../src/cloud/bridge.js";
import { CloudEngine, messageContainsExactText } from "../src/cloud/engine.js";
import { CloudGitHub } from "../src/cloud/catalog.js";
import { enqueueTelegram, enqueueText, TelegramDelivery, processQueue } from "../src/cloud/telegram.js";
import { ConductorApiError, type ConductorApiClient } from "../src/integrations/conductor-api.js";
import { CloudCommands } from "../src/cloud/commands.js";
import { readWorkspaceArtifact } from "../src/mcp/remote.js";
import { acquireGatewayLease } from "../src/cloud/runtime.js";
import {CloudPoller} from "../src/cloud/poller.js";

async function fixture(fn: (f: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  const f = createFixture();
  try { await fn(f); } finally { closeDb(); rmSync(f.dir, { recursive: true, force: true }); }
}
function createFixture() {
  closeDb(); const dir = mkdtempSync(path.join(os.tmpdir(), "ct-cloud-"));
  const store = new GatewayStore(getDb(path.join(dir, "state.db")));
  const ws = createWorkspace({ name: "test", prompt: "Fix the bug", repoPath: "conductor-project:p1", telegramChatId: "42" });
  const bridge = new FileBridge(store, "http://127.0.0.1", path.join(dir, "files"));
  const messages: any[] = [];
  let creates = 0; let sends = 0;
  const sessions: any[] = [{ id: "s1", name: "Task", deepLink: "conductor://s1" }];
  let sessionStatus: "idle" | "working" | "error" = "idle";
  let errorMessage = "quota exhausted";
  const api = {
    listProjects: async () => [{ id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git" }],
    getIdentity: async () => ({ userId: "owner" }),
    createWorkspace: async () => { creates++; return { workspaceId: "w1", sessionId: "s1", deepLink: "conductor://w1" }; },
    getWorkspace: async () => ({ id: "w1", name: "workspace", repoUrl: "https://github.com/org/repo", deepLink: "conductor://w1" }),
    getWorkspaceStatus: async () => ({ workspaceId: "w1", status: "ready" }),
    listProjectWorkspaces: async () => [],
    listWorkspaceSessions: async () => sessions,
    createSession: async (input: any) => { const session = { id: `s${sessions.length + 1}`, name: input.name, deepLink: "conductor://session" }; sessions.push(session); return session; },
    getSessionStatus: async (sessionId: string) => ({ workspaceId: "w1", sessionId, status: sessionStatus, errorMessage }),
    getMessage: async (id: string) => { const message = messages.find(m => m.id === id); if (!message) throw new ConductorApiError("Not found", 404); return message; },
    sendMessage: async (input: any) => { sends++; messages.push({ id: input.messageId, sessionId: input.sessionId, type: "user", content: input.message, sessionIndex: messages.length, receivedAt: new Date().toISOString() }); return { messageId: input.messageId, state: "sent" }; },
    listSessionMessages: async ({ sessionId, after }: any) => {
      const filtered = messages.filter(m => m.sessionId === sessionId); const index = filtered.findIndex(m => m.id === after);
      return after ? filtered.slice(index + 1) : filtered;
    },
    getSessionMessageTail: async (id: string) => messages.filter(m => m.sessionId === id),
    getLatestSessionMessage: async (id: string) => messages.filter(m => m.sessionId === id).at(-1) ?? null,
    cancelSession: async (id: string) => ({ workspaceId: "w1", sessionId: id, status: "idle", canceledQueuedMessages: 0 }),
    archiveWorkspace: async () => ({ workspaceId: "w1", status: "archived" }),
  };
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, bridge, new CloudGitHub("test"), undefined, true);
  store.set("conductor-user-id", "owner");
  async function launch() { engine.queue("launch", { type: "launch", trackedId: ws.id, projectId: "p1", prompt: "Fix\nthe bug" }); await processQueue(store, ["cloud"], r => engine.action(r)); }
  return { dir, store, ws, bridge, api, engine, messages, sessions, launch, counts: () => ({ creates, sends }),
    status: (value: typeof sessionStatus, detail = errorMessage) => { sessionStatus = value; errorMessage = detail; store.set(`poll-after:${ws.id}`, 0); } };
}

test("cloud launch sends over native API without a desktop database or checkout", () => fixture(async f => {
  await f.launch();
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  assert.equal(f.store.binding(f.ws.id)?.repoSlug, "org/repo");
  assert.equal(getWorkspace(f.ws.id)?.conductorBackendKind, "cloud-api");
  assert.equal(f.store.row("launch")?.state, "done");
}));

test("uncertain workspace creation is reconciled without another create", () => fixture(async f => {
  f.api.createWorkspace = async () => { throw new Error("lost receipt"); };
  await f.launch();
  assert.equal(f.store.get("create-attempt:launch"), true);
  f.store.retry("launch", "retry", 0);
  let duplicate = false; f.api.createWorkspace = async () => { duplicate = true; throw new Error("must not run"); };
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(duplicate, false);
  assert.match(f.store.row("launch")?.error ?? "", /uncertain/);
}));

test("stop during creation prevents the first prompt from being sent", () => fixture(async f => {
  const original = f.api.createWorkspace;
  f.api.createWorkspace = async () => { const created = await original(); f.engine.queue("stop", { type: "stop", trackedId: f.ws.id }); return created; };
  await f.launch();
  assert.equal(f.counts().sends, 0);
  assert.equal(f.store.get(`stop:${f.ws.id}`), true);
}));

test("a lost send receipt is matched by exact multiline payload and never resent", () => fixture(async f => {
  const original = f.api.sendMessage;
  f.api.sendMessage = async (input: any) => { await original(input); throw new Error("lost receipt"); };
  await f.launch(); f.store.retry("launch", "retry", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.counts().sends, 1);
  assert.equal(f.store.row("launch")?.state, "done");
  assert.equal(messageContainsExactText({ content: [{ text: "hello\nworld" }] }, "hello\nworld"), true);
}));

test("idle before the prompt executes is not completion; replies are durably queued before cursors", () => fixture(async f => {
  await f.launch(); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getWorkspace(f.ws.id)?.status, "running");
  f.messages.push({ id: "assistant1", sessionId: "s1", type: "assistant", content: { message: { content: [{ type: "text", text: "Finished" }] } }, sessionIndex: 1, receivedAt: new Date().toISOString() });
  f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(getThreadCursor(f.ws.id, "s1")?.lastMessageId, "assistant1");
  assert.ok(f.store.row("transcript:s1:assistant1:0"));
  assert.equal(getWorkspace(f.ws.id)?.status, "done");
}));

test("quota failure queues one fallback; an API outage never launches a replacement", () => fixture(async f => {
  await f.launch(); f.status("error");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const rows = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").all();
  assert.equal(rows.length, 1);
  f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any).n, 1);
  f.api.getSessionStatus = async () => { throw new Error("API offline"); };
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await assert.rejects(f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!));
  assert.equal(f.sessions.length, 1);
}));

test("transient disconnect attempts same-session continuation before provider replacement", () => fixture(async f => {
  await f.launch(); f.status("error", "connection lost");
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get("recovery-resumed:launch"), true);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'resume:%'").get() as any).n, 1);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any).n, 0);
}));

test("PR review records exact head, uses a separate session, and detects later changes", () => fixture(async f => {
  await f.launch();
  const mergeEvidence = () => ({
    intents: f.store.db.prepare("SELECT * FROM merge_intents").all(),
    decisions: f.store.db.prepare("SELECT * FROM decisions").all(),
  });
  const beforeReview = mergeEvidence();
  let head = "a".repeat(40);
  f.engine.github.pr = async () => ({ url: "https://github.com/org/repo/pull/1", head, base: "b".repeat(40), branch: "feature", number: 1, state: "open", merged: false, draft: false });
  f.engine.queue("review", { type: "review", trackedId: f.ws.id, prompt: "https://github.com/org/repo/pull/1" });
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 2);
  assert.equal(f.store.get<any>("session:s2")?.reviewHead, head);
  assert.equal(f.store.binding(f.ws.id)?.sessionId, "s1");
  f.status("working"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.messages.push({ id: "review-result", sessionId: "s2", type: "assistant", content: "Review findings", sessionIndex: 2, receivedAt: new Date(Date.now() + 100).toISOString() });
  head = "c".repeat(40); f.status("idle"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const completion = f.store.db.prepare("SELECT payload FROM gateway_queue WHERE id LIKE 'complete:s2:%'").all() as any[];
  assert.ok(completion.some(r => JSON.parse(r.payload).payload.text.includes("PR changed")));
  assert.deepEqual(mergeEvidence(), beforeReview, "Review completion must not create merge authorization or approve a human decision");
}));

test("sleep during an unfinished task queues one same-session continuation and preserves explicit stop", () => fixture(async f => {
  await f.launch();
  f.api.getWorkspaceStatus = async () => ({workspaceId: "w1", status: "sleeping"});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const wakes = () => f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'wake:%'").all() as any[];
  assert.equal(wakes().length, 1);
  const continuation = JSON.parse(wakes()[0].payload);
  assert.equal(continuation.sessionId, "s1");
  assert.equal(continuation.recovery, true);
  assert.match(continuation.prompt, /continue only unfinished work/);
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(wakes().length, 1);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.deepEqual(f.counts(), {creates: 1, sends: 2});
  assert.equal(f.sessions.length, 1);
  f.engine.queue("owner-stop", {type: "stop", trackedId: f.ws.id});
  f.store.set(`poll-after:${f.ws.id}`, 0);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.counts().sends, 2);
}));

test("document intake keeps caption and file private, releases its reservation, and deduplicates on retry", () => fixture(async f => {
  await f.launch();
  updateWorkspaceThreadId(f.ws.id, 7);
  const previousToken = process.env.BOT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BOT_TOKEN = "test-only-placeholder";
  globalThis.fetch = (async (url: string | URL | Request) => {
    assert.equal(String(url), "https://api.telegram.org/file/bottest-only-placeholder/documents/input.txt");
    return new Response(Buffer.from("user attachment bytes"));
  }) as typeof fetch;
  const commands = new CloudCommands(f.store, f.engine, async (method) => {
    assert.equal(method, "getFile");
    return {file_path: "documents/input.txt", file_size: 21};
  }, "42", "7");
  try {
    f.store.ingest([{update_id: 90, message: {message_id: 90, chat: {id: 42}, from: {id: 7}, message_thread_id: 7,
      caption: "Check this\nagainst the task", document: {file_id: "input-doc", file_name: "input.txt"}}}]);
    await processQueue(f.store, ["update"], r => commands.handle(r));
    assert.equal(JSON.parse(f.store.row("update:90:action")!.payload).mediaPending, true);
    await processQueue(f.store, ["media"], r => commands.media(r));
    const prepared = JSON.parse(f.store.row("update:90:action")!.payload);
    assert.equal(prepared.mediaPending, false);
    assert.equal(prepared.prompt, "Check this\nagainst the task");
    assert.equal(prepared.fileIds.length, 1);
    assert.equal(f.bridge.file(prepared.fileIds[0], f.ws.id)?.name, "input.txt");
    f.store.retry("update:90:media", "simulate lost processing receipt", 0);
    await processQueue(f.store, ["media"], r => commands.media(r));
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_files").get() as any).n, 1);
    await processQueue(f.store, ["cloud"], r => f.engine.action(r));
    const sent = f.messages.at(-1).content;
    assert.match(sent, /Check this\nagainst the task/);
    assert.match(sent, /\/v1\/attachments\//);
    assert.doesNotMatch(sent, /api\.telegram\.org|test-only-placeholder/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = previousToken;
  }
}));

test("question send failures and 429 cooldown preserve the question and reply link", () => fixture(async f => {
  const receipt = f.bridge.event(f.ws.id, { id: randomUUID(), type: "human_request", payload: { question: "Continue?", options: ["Yes", "No"] } });
  f.engine.events();
  let calls = 0;
  const sender = new TelegramDelivery(f.store, async () => { calls++; if (calls === 1) throw { response: { error_code: 429, parameters: { retry_after: 39 }, description: "Too Many Requests" } }; return { message_id: 101 }; });
  await sender.tick();
  assert.ok((f.store.get<number>("telegram-not-before") ?? 0) > Date.now() + 38_000);
  await sender.tick(); assert.equal(calls, 1);
  const row = f.store.db.prepare("SELECT id FROM gateway_queue WHERE kind='telegram'").get() as any;
  f.store.set("telegram-not-before", 0); f.store.retry(row.id, "retry", 0);
  await sender.tick();
  const restarted = new GatewayStore(f.store.db);
  assert.equal(restarted.decisionForMessage("42", 101), receipt.decisionId);
  assert.equal(restarted.decisionForMessage("other", 101), undefined);
  assert.equal(getWorkspaceMessageTarget("42", "101")?.workspace.id, f.ws.id);
}));

test("unchanged topic updates are successful and never block following messages", () => fixture(async f => {
  enqueueTelegram(f.store, "topic", { method: "editForumTopic", payload: { chat_id: "42", message_thread_id: 1, name: "test" } });
  const sender = new TelegramDelivery(f.store, async () => { throw { response: { error_code: 400, description: "TOPIC_NOT_MODIFIED" } }; });
  await sender.tick(); assert.equal(f.store.row("topic")?.state, "done");
}));

test("scoped bridge rejects another workspace's files and decisions; event retries deduplicate", () => fixture(async f => {
  const other = createWorkspace({ name: "other", prompt: "x", repoPath: "x", telegramChatId: "42" });
  const a = f.bridge.issueCredential(f.ws.id), b = f.bridge.issueCredential(other.id);
  assert.equal(f.bridge.authorize(a), f.ws.id); assert.equal(f.bridge.authorize(b), other.id);
  const file = f.bridge.save(f.ws.id, "../../test.txt", Buffer.from("hello"));
  assert.equal(f.bridge.file(file)?.name, "test.txt");
  assert.throws(() => f.bridge.link(file, other.id));
  const link = new URL(f.bridge.link(file, f.ws.id));
  assert.ok(f.bridge.validLink(file, link.searchParams.get("token")!));
  assert.equal(f.bridge.validLink(file, link.searchParams.get("token")!, Date.now() + 16 * 60_000), undefined);
  const event = { id: randomUUID(), type: "human_request", payload: { question: "Question?" } };
  const first = f.bridge.event(f.ws.id, event); const retry = f.bridge.event(f.ws.id, event);
  assert.equal(first.decisionId, retry.decisionId);
  const server = startBridge(f.bridge, 0); await once(server, "listening");
  try {
    const port = (server.address() as any).port;
    const response = await fetch(`http://127.0.0.1:${port}/v1/decisions/${first.decisionId}`, { headers: { Authorization: `Bearer ${b}` } });
    assert.equal(response.status, 404);
    answerDecision(first.decisionId!, "Yes");
    const own = await fetch(`http://127.0.0.1:${port}/v1/decisions/${first.decisionId}`, { headers: { Authorization: `Bearer ${a}` } });
    assert.deepEqual(await own.json(), { answer: "Yes" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("cloud file reports reject symlink escapes and secret files", () => fixture(async f => {
  const root = path.join(f.dir, "files"); writeFileSync(path.join(f.dir, "outside"), "secret");
  symlinkSync(path.join(f.dir, "outside"), path.join(root, "escape")); writeFileSync(path.join(root, ".env"), "secret");
  assert.throws(() => readWorkspaceArtifact("escape", root));
  assert.throws(() => readWorkspaceArtifact(".env", root));
}));

test("native commands acknowledge and queue work; owner checks prevent outsider updates", () => fixture(async f => {
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42", "9");
  f.store.ingest([{ update_id: 1, message: { message_id: 2, chat: { id: 42 }, from: { id: 10 }, text: "/run p1 task" } }]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  f.store.ingest([{ update_id: 2, message: { message_id: 3, chat: { id: 42 }, from: { id: 9 }, text: "/run p1 task\n  preserve formatting" } }]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 1);
  assert.equal(f.counts().creates, 0);
  assert.equal(JSON.parse(f.store.row("update:2:action")!.payload).prompt, "task\n  preserve formatting");
}));

test("gateway lease prevents concurrent pollers and permits takeover only after expiry", () => fixture(async f => {
  assert.equal(acquireGatewayLease(f.store, "one", 1000), true);
  assert.equal(acquireGatewayLease(f.store, "two", 2000), false);
  assert.equal(acquireGatewayLease(f.store, "two", 92_000), true);
  assert.equal(acquireGatewayLease(f.store, "one", 93_000), false);
}));

test("a failed attachment unblocks later work and does not replay a stopped attachment", () => fixture(async f => {
  await f.launch();
  f.engine.queue("attachment:action", {type: "send", trackedId: f.ws.id, mediaPending: true});
  f.store.enqueue("media", "42:0", {}, "attachment:media"); f.store.retry("attachment:media", "Conversion failed", 0, true);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("attachment:action")?.state, "blocked");
  f.engine.queue("following", {type: "send", trackedId: f.ws.id, prompt: "Text follow-up"});
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.store.row("following")?.state, "done");
}));

test("ping is ingested independently of a stalled conversation", () => fixture(async f => {
  f.store.ingest([{update_id: 1, message: {chat: {id: 42}, text: "/run p1 slow"}}, {update_id: 2, message: {chat: {id: 42}, text: "/ping"}}]);
  f.store.claim(["update"], 1);
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42");
  await processQueue(f.store, ["health-update"], row => commands.handle(row));
  assert.equal(f.store.row("update:2")?.state, "done");
  assert.ok(f.store.row("update:2:reply:0"));
}));

test("queued expired attachment links renew without changing the message payload", () => fixture(async f => {
  const id = f.bridge.save(f.ws.id, "photo.jpg", Buffer.from("photo"));
  const original = f.bridge.link(id, f.ws.id); const token = new URL(original).searchParams.get("token")!;
  f.store.db.prepare("UPDATE gateway_file_links SET expires_at=0 WHERE file_id=?").run(id);
  assert.equal(f.bridge.validLink(id, token), undefined);
  f.bridge.refreshQueuedLinks(`Download ${original}`, f.ws.id);
  assert.ok(f.bridge.validLink(id, token));
}));

test("all eligible providers are attempted once and a user stop prevents further recovery", () => fixture(async f => {
  await f.launch();
  for (let i = 0; i < 3; i++) {
    f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
    await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  }
  assert.equal(f.sessions.length, 3);
  assert.deepEqual(f.store.get("recovery-providers:launch"), ["claude", "codex", "cursor"]);
  f.engine.queue("stop", {type: "stop", trackedId: f.ws.id});
  f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.sessions.length, 3);
}));

test("topic maintenance coalesces and does not outrank transcript messages", () => fixture(async f => {
  const payload = {chat_id: "42", message_thread_id: 1, name: "first"};
  enqueueTelegram(f.store, "first-topic", {method: "editForumTopic", payload}, 20);
  enqueueTelegram(f.store, "last-topic", {method: "editForumTopic", payload: {...payload, name: "last"}}, 20);
  enqueueText(f.store, "text", "42", "Progress");
  const methods: string[] = [];
  const sender = new TelegramDelivery(f.store, async method => {methods.push(method); return {message_id: 1};});
  await sender.tick();
  assert.equal(f.store.row("first-topic")?.state, "done"); assert.deepEqual(methods, ["sendMessage"]);
}));

test("deleted topics are recreated before retrying their message", () => fixture(async f => {
  updateWorkspaceThreadId(f.ws.id, 10);
  enqueueText(f.store, "message", "42", "Progress", {workspaceId: f.ws.id, threadId: 10});
  const calls: any[] = [];
  const sender = new TelegramDelivery(f.store, async (method, payload) => {
    calls.push({method, payload});
    if (calls.length === 1) throw {response: {error_code: 400, description: "message thread not found"}};
    return method === "createForumTopic" ? {message_thread_id: 20} : {message_id: 100};
  });
  await sender.tick(); await sender.tick();
  f.store.set("telegram-chat-after:42", 0); f.store.retry("message:0", "retry", 0);
  await sender.tick(); assert.equal(calls[2].payload.message_thread_id, 20);
}));

test("polling reaches workspaces beyond 100 while another workspace is stalled, with concurrency four", () => fixture(async f => {
  await f.launch(); const template = f.store.binding(f.ws.id)!;
  for (let i = 0; i < 106; i++) f.store.bind(`workspace-${i}`, {...template, workspaceId: `remote-${i}`});
  const visited = new Set<string>(); let active = 0, maximum = 0; let release!: () => void;
  const stalled = new Promise<void>(resolve => {release = resolve;});
  f.engine.pollWorkspace = async id => {
    active++; maximum = Math.max(maximum, active); visited.add(id);
    if (id === f.ws.id) await stalled;
    else await new Promise(resolve => setImmediate(resolve));
    f.store.set(`poll-after:${id}`, Date.now() + 60_000); active--;
  };
  const poller = new CloudPoller(f.engine);
  for (let i = 0; i < 110; i++) {poller.tick(); await new Promise(resolve => setImmediate(resolve));}
  assert.ok(visited.has("workspace-105")); assert.ok(maximum <= 4);
  release(); await poller.settled();
}));

test("fallback rechecks the previous session and refuses a cancellation race", () => fixture(async f => {
  await f.launch(); f.status("error"); await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  f.status("working"); await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.sessions.length, 1);
  const blocked = f.store.db.prepare("SELECT state FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.equal(blocked.state, "blocked");
}));

test("an unavailable provider rejected before launch is skipped without an uncertain replay", () => fixture(async f => {
  const original = f.api.createWorkspace; let attempts = 0;
  f.api.createWorkspace = async () => {if (++attempts === 1) throw new ConductorApiError("Provider model unavailable", 400); return original();};
  await f.launch(); f.store.retry("launch", "eligible fallback", 0);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.binding(f.ws.id)?.agent, "codex"); assert.equal(f.counts().sends, 1);
  assert.deepEqual(f.store.get("recovery-providers:launch"), ["claude", "codex"]);
}));

test("partial multi-message delivery resumes without repeating recorded receipts", () => fixture(async f => {
  enqueueText(f.store, "long", "42", "hello ".repeat(1200));
  let attempts = 0; const sent: string[] = [];
  const sender = new TelegramDelivery(f.store, async (_method, payload) => {
    attempts++; if (attempts === 2) throw new Error("network down"); sent.push(payload.text); return {message_id: attempts};
  });
  await sender.tick(); f.store.set("telegram-chat-after:42", 0); await sender.tick();
  f.store.recover(); f.store.set("telegram-not-before", 0); f.store.retry("long:1", "restored", 0);
  await sender.tick(); assert.equal(sent.length, 2); assert.equal(attempts, 3);
  assert.equal(sent.join(""), "hello ".repeat(1200));
}));

test("historical unanswered questions are retained without reopening archived work", () => fixture(async f => {
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Old question"}});
  f.store.db.prepare("UPDATE workspaces SET status='archived',archived_at=datetime('now') WHERE id=?").run(f.ws.id);
  f.engine.events();
  assert.ok(getDecision(receipt.decisionId!));
  assert.equal(f.store.row(`decision:${receipt.decisionId}:0`), undefined);
}));

test("Telegram media rate limits persist their full cooldown and native outages stay retryable", () => fixture(async f => {
  f.store.enqueue("media", "42", {}, "media");
  await processQueue(f.store, ["media"], async () => {throw {response: {error_code: 429, description: "Rate limited", parameters: {retry_after: 90}}};});
  assert.ok(f.store.row("media")!.available_at > Date.now() + 89_000);
  f.store.enqueue("cloud", f.ws.id, {}, "outage");
  for (let i = 0; i < 8; i++) {
    f.store.retry("outage", "probe", 0);
    await processQueue(f.store, ["cloud"], async () => {throw new ConductorApiError("Unavailable", 503, true, 120_000);});
  }
  assert.equal(f.store.row("outage")?.state, "pending");
  assert.ok(f.store.row("outage")!.available_at > Date.now() + 119_000);
}));
