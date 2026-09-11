import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { getDb, closeDb } from "../src/store/db.js";
import { createWorkspace, getWorkspace, getDecision, answerDecision, getWorkspaceMessageTarget, getThreadCursor, updateWorkspaceThreadId, upsertRepoTopic, linkTelegramMessage } from "../src/store/queries.js";
import { GatewayStore } from "../src/cloud/store.js";
import { FileBridge, startBridge } from "../src/cloud/bridge.js";
import { CloudEngine, messageContainsExactText } from "../src/cloud/engine.js";
import { CloudGitHub } from "../src/cloud/catalog.js";
import { enqueueTelegram, enqueueText, TelegramDelivery, processQueue } from "../src/cloud/telegram.js";
import { ConductorApiError, type ConductorApiClient } from "../src/integrations/conductor-api.js";
import { CloudCommands, repoTopicCandidates } from "../src/cloud/commands.js";
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

/** Every repo-topic test needs the same forum group, the topic row, and owner-scoped commands. */
function repoTopic(f: ReturnType<typeof createFixture>, repoName: string, threadId = 5): CloudCommands {
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  upsertRepoTopic({chatId: "-42", repoPath: `/Users/legacy/repos/${repoName}`, repoName, telegramThreadId: threadId});
  return new CloudCommands(f.store, f.engine, async () => ({}), "-42", "9");
}

test("cloud launch sends over native API without a desktop database or checkout", () => fixture(async f => {
  await f.launch();
  assert.deepEqual(f.counts(), { creates: 1, sends: 1 });
  assert.equal(f.store.binding(f.ws.id)?.repoSlug, "org/repo");
  assert.equal(getWorkspace(f.ws.id)?.conductorBackendKind, "cloud-api");
  assert.equal(f.store.row("launch")?.state, "done");
}));

test("replies to migrated local history never queue cloud work against an unbound record", () => fixture(async f => {
  f.store.db.prepare("UPDATE workspaces SET repo_path=?,status='done' WHERE id=?").run("/Users/legacy/project", f.ws.id);
  const before = getWorkspace(f.ws.id);
  const {linkTelegramMessage} = await import("../src/store/queries.js");
  linkTelegramMessage("42", "90", f.ws.id, "legacy-session");
  const commands = new CloudCommands(f.store, f.engine, async () => ({}), "42");
  for (const [i, extra] of [{text: "continue"}, {text: "/send continue"}, {voice: {file_id: "voice"}}].entries()) {
    const id=i+1;
    f.store.ingest([{update_id: id, message: {message_id: 100+id, chat: {id: 42}, reply_to_message: {message_id: 90}, ...extra}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(f.store.row(`update:${id}:action`), undefined);
    assert.equal(f.store.row(`update:${id}:media`), undefined);
    assert.match(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.text, /historical.*\/run/is);
  }
  assert.deepEqual(getWorkspace(f.ws.id), before);
  assert.deepEqual(f.counts(), {creates: 0, sends: 0});
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: 42}, reply_to_message: {message_id: 90}, text: "/run p1 Start new work"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action=JSON.parse(f.store.row("update:4:action")!.payload);
  assert.notEqual(action.trackedId, f.ws.id);
  assert.equal(action.projectId, "p1");
  assert.equal(action.sessionId, undefined);
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

test("a lost native send receipt is reconciled through its distinct transcript row", () => fixture(async f => {
  let sends = 0;
  f.api.sendMessage = async input => {
    sends++;
    f.messages.push({id: "native-row", sessionId: input.sessionId, type: "userMessage", sessionIndex: 1,
      content: {id: input.messageId, message: input.message}, receivedAt: new Date().toISOString()});
    throw new Error("lost receipt");
  };
  await f.launch();
  f.store.retry("launch", "reconcile", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(sends, 1);
  assert.equal(f.store.row("launch")?.state, "done");
}));

test("a missing receipt cannot replay a command whose submission was attempted", () => fixture(async f => {
  let sends = 0;
  f.api.sendMessage = async () => {sends++; throw new Error("lost receipt before transcript visibility");};
  await f.launch();
  f.store.retry("launch", "reconcile", 0);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(sends, 1);
  assert.match(f.store.row("launch")?.error ?? "", /uncertain/);
}));

test("native turn failure with an idle session recovers only after terminal confirmation", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity", codexErrorInfo: "serverOverloaded"}}}}});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const row = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.ok(row);
  assert.equal(JSON.parse(row.payload).previousMessageId, state.sentMessageId);
  await processQueue(f.store, ["cloud"], r => f.engine.action(r));
  assert.equal(f.sessions.length, 2);
  assert.equal(f.store.row(row.id)?.state, "done");
}));

test("a native failed turn cannot trigger replacement after the session starts working again", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity"}}}}});
  let reads = 0;
  f.api.getSessionStatus = async sessionId => ({workspaceId: "w1", sessionId, status: ++reads === 1 ? "idle" : "working", errorMessage: ""});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.store.db.prepare("SELECT id FROM gateway_queue WHERE id LIKE 'recover:%'").get(), undefined);
}));

test("an older failed turn cannot replace a newly submitted turn", () => fixture(async f => {
  await f.launch();
  const state = f.store.get<any>("session:s1");
  f.messages.push({id: "failed-turn", sessionId: "s1", type: "agent", sessionIndex: 2, receivedAt: new Date().toISOString(),
    content: {turnId: state.sentMessageId, rawPayload: {event: {type: "turn.failed", error: {message: "Selected model is at capacity"}}}}});
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const recovery = f.store.db.prepare("SELECT * FROM gateway_queue WHERE id LIKE 'recover:%'").get() as any;
  assert.ok(recovery);
  f.store.set("session:s1", {...f.store.get<any>("session:s1"), sentMessageId: "new-command", nativeFailure: undefined});
  await f.engine.action(recovery);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.store.row(recovery.id)?.state, "blocked");
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

test("human questions bypass transcript backlog and retain reply associations after restart", () => fixture(async f => {
  enqueueText(f.store, "earlier-transcript", "42", "Background progress", {workspaceId: f.ws.id, sessionId: "s1"});
  const receipt = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Which target?"}});
  f.engine.events();
  const sent: string[] = [];
  const delivery = new TelegramDelivery(f.store, async (_method, payload) => {sent.push(payload.text); return {message_id: 101};});
  await delivery.tick();
  assert.match(sent[0], /Which target\?/);
  assert.equal(f.store.row("earlier-transcript:0")?.state, "pending");
  const restarted = new GatewayStore(f.store.db);
  assert.equal(restarted.decisionForMessage("42", 101), receipt.decisionId);
  assert.equal(getWorkspaceMessageTarget("42", "101")?.workspace.id, f.ws.id);
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

test("group authorization rejects impersonation, foreign chats, media, replies and control buttons before side effects", () => fixture(async f => {
  await f.launch();
  f.store.db.prepare("UPDATE workspaces SET telegram_chat_id='-42' WHERE id=?").run(f.ws.id);
  updateWorkspaceThreadId(f.ws.id, 7);
  const decision = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Approve?", options: ["Yes", "No"]}}).decisionId!;
  f.store.linkDecision("-42", 100, decision);
  f.store.set("route:access-test", {chatId: "-42", action: {type: "stop", trackedId: f.ws.id}});
  f.store.set("thread:access-test", {trackedId: f.ws.id, sessionId: "other-session"});
  f.store.set("bindtopic:access-test", {chatId: "-42", threadId: 7, projectId: "p1", projectName: "repo"});
  let externalCalls = 0;
  const unexpectedCall = async () => {externalCalls++; throw new Error("Unauthorized request reached an external API");};
  for (const key of Object.keys(f.api)) (f.api as any)[key] = unexpectedCall;
  const commands = new CloudCommands(f.store, f.engine, unexpectedCall, "-42", "9", "-42");
  const snapshot = () => ({
    workspace: getWorkspace(f.ws.id), decision: getDecision(decision), bindings: f.store.bindings(),
    state: f.store.db.prepare("SELECT * FROM gateway_state WHERE key != 'telegram-offset' ORDER BY key").all(),
    queue: f.store.db.prepare("SELECT * FROM gateway_queue WHERE kind NOT IN ('update','health-update') ORDER BY id").all(),
    links: f.store.db.prepare("SELECT * FROM telegram_message_links ORDER BY chat_id,telegram_message_id").all(),
  });
  const before = snapshot();
  const identities = [
    {name: "another group member with the owner's username", chat: -42, from: {id: 10, username: "OwnerName"}},
    {name: "anonymous group administrator", chat: -42, from: {id: 11, is_bot: true}},
    {name: "missing sender", chat: -42, from: undefined},
    {name: "owner in a foreign group", chat: -43, from: {id: 9}},
    {name: "owner in an unapproved private chat", chat: 9, from: {id: 9}},
  ];
  const payloads: Record<string, unknown>[] = [
    ...["/run p1 deploy", "/link", "/link repo", "/send deploy", "/stop", "/archive", "/review https://github.com/org/repo/pull/1",
      "/threads", "/threads new deploy", "/rename changed", "/renamethread changed", "/repos", "/fleet", "/lanes",
      "/sync", "/status", "/decisions", "/ping", "/setup", `/answer ${decision} Yes`, "deploy now"].map(text => ({text})),
    {text: "Yes", reply_to_message: {message_id: 100}},
    {voice: {file_id: "voice"}, reply_to_message: {message_id: 100}},
    {audio: {file_id: "audio"}}, {photo: [{file_id: "photo"}]}, {document: {file_id: "document"}, caption: "/send deploy"},
  ];
  let updateId = 0;
  async function rejected(update: Record<string, unknown>, label: string) {
    const id = ++updateId;
    f.store.ingest([{update_id: id, ...update}]);
    await processQueue(f.store, ["update", "health-update"], row => commands.handle(row));
    assert.equal(f.store.row(`update:${id}`)?.state, "done", label);
    assert.equal(externalCalls, 0, label);
    assert.deepEqual(snapshot(), before, label);
  }
  for (const identity of identities) {
    for (const payload of payloads) await rejected({message: {message_id: 200 + updateId, chat: {id: identity.chat},
      from: identity.from, message_thread_id: 7, ...payload}}, identity.name);
    for (const data of [`decision:${decision}:0`, "route:access-test", "thread:access-test", "bindtopic:access-test"]) {
      await rejected({callback_query: {id: `callback-${updateId}`, from: identity.from, data,
        message: {message_id: 100, chat: {id: identity.chat}, from: {id: 99, is_bot: true}, message_thread_id: 7}}}, `${identity.name}: ${data}`);
    }
  }
  // The original message may be from the owner; only the person clicking can authorize a callback.
  await rejected({callback_query: {id: "foreign-click", from: {id: 10}, data: `decision:${decision}:0`,
    message: {message_id: 100, chat: {id: -42}, from: {id: 9}, message_thread_id: 7}}}, "foreign click on owner's message");

  f.store.ingest([{update_id: ++updateId, message: {message_id: 500, chat: {id: -42}, from: {id: 9, username: "ChangedName"},
    message_thread_id: 7, text: "/send continue"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row(`update:${updateId}:action`)!.payload).trackedId, f.ws.id);
  f.store.ingest([{update_id: ++updateId, callback_query: {id: "owner-click", from: {id: 9}, data: `decision:${decision}:0`,
    message: {message_id: 100, chat: {id: -42}, from: {id: 99, is_bot: true}, message_thread_id: 7}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(getDecision(decision)?.answer, "Yes");
  assert.equal(externalCalls, 0, "authorized commands queue work without doing network work during ingestion");
}));

test("HTTP bridge credentials cannot answer approvals, impersonate workspaces or bypass revocation", () => fixture(async f => {
  const other = createWorkspace({name: "other", prompt: "Other task", repoPath: "conductor-project:p1", telegramChatId: "42"});
  const credential = f.bridge.issueCredential(f.ws.id);
  const own = f.bridge.event(f.ws.id, {id: randomUUID(), type: "human_request", payload: {question: "Own question?"}}).decisionId!;
  const foreign = f.bridge.event(other.id, {id: randomUUID(), type: "human_request", payload: {question: "Private question?"}}).decisionId!;
  const file = f.bridge.save(other.id, "private.txt", Buffer.from("private contents"));
  const server = startBridge(f.bridge, 0); await once(server, "listening");
  try {
    const origin = `http://127.0.0.1:${(server.address() as any).port}`;
    const request = (route: string, method = "GET", body?: unknown, token = credential) => fetch(`${origin}${route}`, {
      method, headers: {Authorization: `Bearer ${token}`, "Content-Type": "application/json"},
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    });
    for (const token of ["", "invalid"]) {
      for (const route of ["/v1/decisions", "/v1/client", "/v1/bootstrap"]) {
        assert.equal((await request(route, "GET", undefined, token)).status, 401);
      }
      assert.equal((await request("/v1/events", "POST", {}, token)).status, 401);
      assert.equal((await request("/v1/attachments", "POST", {}, token)).status, 401);
    }
    const listed = await (await request(`/v1/decisions?workspaceId=${other.id}`)).json() as any;
    assert.deepEqual(listed.decisions.map((d: any) => d.id), [own]);
    assert.equal((await request(`/v1/decisions/${foreign}`)).status, 404);
    assert.equal((await request(`/v1/decisions/${own}`, "POST", {answer: "Yes"})).status, 404);
    assert.equal((await request(`/v1/attachments/${file}`, "POST", {})).status, 400);
    assert.equal((await request(`/v1/attachments/${file}?token=invalid`)).status, 404);
    const event = {id: randomUUID(), type: "human_request", payload: {question: "Forged question?"}};
    for (const forged of [{...event, workspaceId: other.id}, {...event, type: "run"},
      {...event, type: "decision", payload: {id: own, answer: "Yes"}},
      {...event, type: "artifact", payload: {type: "file", url: `attachment:${file}`, description: "Foreign file"}}]) {
      assert.equal((await request("/v1/events", "POST", forged)).status, 400);
    }
    assert.equal(getDecision(own)?.answer, null);
    assert.equal(getDecision(foreign)?.answer, null);
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM decisions").get() as any).n, 2);
    f.store.db.prepare("UPDATE gateway_credentials SET revoked=1 WHERE workspace_id=?").run(f.ws.id);
    assert.equal((await request("/v1/decisions")).status, 401);
    const replacement = f.bridge.issueCredential(f.ws.id);
    assert.equal((await request("/v1/decisions", "GET", undefined, replacement)).status, 200);
    f.store.db.prepare("UPDATE workspaces SET archived_at=datetime('now') WHERE id=?").run(f.ws.id);
    assert.equal((await request("/v1/decisions", "GET", undefined, replacement)).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
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

test("native out-of-usage-credits errors recover once after confirming an idle session", () => fixture(async f => {
  await f.launch();
  const sent = f.store.get<any>('session:s1').sentMessageId;
  f.messages.push({id: 'credits-error', sessionId: 's1', sessionIndex: 1, type: 'agent', receivedAt: new Date().toISOString(),
    content: {userMessageId: sent, rawPayload: {type: 'result', subtype: 'error_during_execution', is_error: true,
      result: "You're out of usage credits. Switch to another model to continue."}}});
  f.status('idle');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.equal(f.store.get<any>('session:s1').recoveryAttempted, true);
  const recovery = (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='cloud'").all() as Array<{payload: string}>)
    .map(row => JSON.parse(row.payload)).filter(action => action.recovery);
  assert.equal(recovery.length, 1); assert.equal(recovery[0].provider.agent, 'codex');
  assert.equal(recovery[0].previousSessionId, 's1'); assert.equal(recovery[0].previousMessageId, sent);
  assert.deepEqual(f.counts(), {creates: 1, sends: 1}, 'the original native command was not replayed');
}));

test("an inaccessible selected model falls back only after its native turn stops", () => fixture(async f => {
  await f.launch();
  const sent = f.store.get<any>('session:s1').sentMessageId;
  f.messages.push({id: 'model-error', sessionId: 's1', sessionIndex: 1, type: 'agent', receivedAt: new Date().toISOString(),
    content: {userMessageId: sent, rawPayload: {type: 'result', subtype: 'error_during_execution', is_error: true,
      result: "There's an issue with the selected model (gpt-5.6-sol). It may not exist or you may not have access to it."}}});
  f.status('working');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  assert.ok(!f.store.get<any>('session:s1').recoveryAttempted, 'a working session cannot be replaced');
  f.status('idle');
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  await f.engine.pollWorkspace(f.ws.id, f.store.binding(f.ws.id)!);
  const recovery = (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='cloud'").all() as Array<{payload: string}>)
    .map(row => JSON.parse(row.payload)).filter(action => action.recovery);
  assert.equal(recovery.length, 1);
  assert.equal(recovery[0].previousSessionId, 's1');
  assert.equal(recovery[0].previousMessageId, sent);
  assert.equal(recovery[0].provider.agent, 'codex');
  assert.deepEqual(f.counts(), {creates: 1, sends: 1}, 'the failed task must not be replayed');
}));

test("a repo topic routes itself to the one project matching its repository name", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "Long Events", gitRemote: "git@github.com:org/long-events.git"},
  ];
  f.api.getWorkspace = async () => ({id: "w1", name: "workspace", repoUrl: "https://github.com/org/long-events", deepLink: "conductor://w1"});
  const commands = repoTopic(f, "long-events");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship the calendar"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  // The remote's repository name authorizes the match; the project's own name never has to agree.
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p2");
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, null);
  const ack = JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text;
  assert.match(ack, /Task received and queued/); assert.match(ack, /now routes to Long Events/);
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.counts().creates, 1);
  assert.equal(JSON.parse(f.store.row(`create-topic:${action.trackedId}`)!.payload).payload.message_thread_id, undefined);
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "second task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const second = JSON.parse(f.store.row("update:2:action")!.payload);
  assert.equal(second.projectId, "p2"); assert.notEqual(second.trackedId, action.trackedId);
  assert.doesNotMatch(JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.text, /now routes to/);
}));

test("an ambiguous repo topic asks once per burst, answers a later attempt, and links on confirmation", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  const inThread = () => (f.store.db.prepare("SELECT payload FROM gateway_queue WHERE kind='telegram'").all() as any[])
    .map(row => JSON.parse(row.payload)).filter(job => job.method === "sendMessage" && job.payload.message_thread_id === 5);
  const pasted = [1, 2, 3].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000, text: `part ${n} of one pasted list`}}));
  f.store.ingest(pasted);
  // One conversation is claimed in order, so this is three separately handled updates.
  for (const _ of pasted) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:3")?.state, "done");
  assert.equal(inThread().length, 1);
  assert.match(inThread()[0].payload.text, /does not match exactly one Conductor project/);
  assert.match(inThread()[0].payload.text, /nothing sent here reaches Conductor yet/);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  const buttons = inThread()[0].payload.reply_markup.inline_keyboard.map((row: any[]) => row[0]);
  assert.deepEqual(buttons.map((b: any) => b.text), ["api \u00b7 org/api", "partner-api \u00b7 partner/api"]);

  // The rest of that paste lands in the next getUpdates batch; Telegram's send time still pairs it.
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    date: 1_700_000_001, text: "the tail of that same paste"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 1);

  // A later attempt is a new message, so silence is never the answer to one.
  f.store.ingest([{update_id: 5, message: {message_id: 105, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    date: 1_700_000_030, text: "try again"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 2);

  // A backlog drained in one batch is many messages, not one burst: each is answered.
  f.store.ingest([6, 7].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000 + n * 600, text: `queued while the gateway was down ${n}`}})));
  for (const _ of [6, 7]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(inThread().length, 4);

  f.store.ingest([{update_id: 8, callback_query: {id: "tap", from: {id: 9}, data: buttons[1].callback_data,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  f.store.ingest([{update_id: 9, message: {message_id: 109, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:9:action")!.payload).projectId, "p2");
}));

test("an explicit /run links its repo topic so later plain messages launch without a command", () => fixture(async f => {
  const commands = repoTopic(f, "other", 6);
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 6, text: "/run p1 first task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:6"), "p1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 6, text: "second task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action = JSON.parse(f.store.row("update:2:action")!.payload);
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p1");
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, null);
  assert.notEqual(action.trackedId, JSON.parse(f.store.row("update:1:action")!.payload).trackedId);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='telegram' AND payload LIKE '%reaches Conductor yet%'").get() as any).n, 0);
}));

test("/link corrects an automatic repo topic route and rejects an unknown project", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "first task"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link nope"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  assert.match(JSON.parse(f.store.row("update:2:reply:0")!.payload).payload.text, /Repository unavailable or ambiguous/);
  f.store.ingest([{update_id: 3, message: {message_id: 103, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const picker = JSON.parse(f.store.row("update:4:bindtopic:0")!.payload).payload;
  assert.deepEqual(picker.reply_markup.inline_keyboard.map((row: any[]) => row[0].text), ["\u25cf other \u00b7 org/other", "repo \u00b7 org/repo"]);
  // An explicit /link reports where the topic points; it never claims a message was dropped.
  assert.match(picker.text, /repo routes to other \u00b7 org\/other/);
  assert.doesNotMatch(picker.text, /reaches Conductor yet/);
  f.store.ingest([{update_id: 5, message: {message_id: 105, chat: {id: -42}, from: {id: 9}, text: "/link repo"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.match(JSON.parse(f.store.row("update:5:reply:0")!.payload).payload.text, /inside a repository topic/);
}));

test("repo topic matching accepts a whole repository name and never a partial one", () => {
  const projects = [
    {id: "p1", name: "Long Events", gitRemote: "git@github.com:org/long-events.git"},
    {id: "p2", name: "long-events-admin", gitRemote: "https://github.com/org/long-events-admin"},
    {id: "p3", name: "api", gitRemote: "ssh://git@github.com/org/api.git"},
    {id: "p4", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
    {id: "p5", name: "broken", gitRemote: "not a remote"},
  ];
  const ids = (name: string) => repoTopicCandidates(name, projects as any).map(p => p.id);
  assert.deepEqual(ids("long-events"), ["p1"]);
  assert.deepEqual(ids("LONG-EVENTS"), ["p1"]);
  assert.deepEqual(ids("Long Events"), ["p1"]);
  // Two repositories share a name, so the topic has no single identity to route on.
  assert.deepEqual(ids("api"), ["p3", "p4"]);
  // A prefix, a suffix and an empty name are never a match.
  assert.deepEqual(ids("long"), []);
  assert.deepEqual(ids("events"), []);
  assert.deepEqual(ids("  "), []);
  assert.deepEqual(ids("not a remote"), []);
});

test("a repo topic with nothing to offer asks for /link without an empty keyboard and forwards nothing", () => fixture(async f => {
  f.api.listProjects = async () => [];
  const commands = repoTopic(f, "orphan");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    photo: [{file_id: "thumb"}, {file_id: "full"}], caption: "fix this screenshot"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const notice = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload;
  assert.match(notice.text, /nothing sent here reaches Conductor yet/);
  assert.match(notice.text, /Use \/projects, then \/link/);
  // An empty catalog has nothing to pick, so Telegram must not be sent a keyboard with no buttons.
  assert.equal(notice.reply_markup, undefined);
  // An attachment nobody can route is never uploaded or queued against a guessed project.
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind IN ('cloud','media')").get() as any).n, 0);
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
}));

test("an ambiguous repo topic ranks related projects first and offers at most four", () => fixture(async f => {
  f.api.listProjects = async () => ["api-tools", "my-api-service", "alpha", "beta", "delta", "gamma"]
    .map((name, i) => ({id: `a${i}`, name, gitRemote: `git@github.com:org/${name}.git`}));
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const notice = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload;
  // Projects whose name contains the repository sort above unrelated ones, and a long catalog is truncated.
  assert.deepEqual(notice.reply_markup.inline_keyboard.map((row: any[]) => row[0].text),
    ["api-tools \u00b7 org/api-tools", "my-api-service \u00b7 org/my-api-service", "alpha \u00b7 org/alpha", "beta \u00b7 org/beta"]);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
}));

test("a photo in a repo topic auto-links, launches its own workspace, and leaves the repo topic free", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "Screens", gitRemote: "git@github.com:org/screens.git"},
  ];
  const commands = repoTopic(f, "screens");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    photo: [{file_id: "thumb"}, {file_id: "full"}]}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p2"); assert.equal(action.mediaPending, true);
  assert.equal(JSON.parse(f.store.row("update:1:media")!.payload).fileId, "full");
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, null);
  const ack = JSON.parse(f.store.row("update:1:reply:0")!.payload).payload.text;
  assert.match(ack, /Attachment received/); assert.match(ack, /now routes to Screens/);
}));

test("a topic link tap from another topic or an expired button changes nothing", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const data = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  // A button belongs to the topic it was offered in; the same owner tapping it elsewhere links nothing.
  f.store.ingest([{update_id: 2, callback_query: {id: "elsewhere", from: {id: 9}, data,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 6}}}]);
  f.store.ingest([{update_id: 3, callback_query: {id: "expired", from: {id: 9}, data: "bindtopic:expired",
    message: {message_id: 201, chat: {id: -42}, message_thread_id: 5}}}]);
  for (const _ of [2, 3]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.equal(f.store.get("repo-topic-project:-42:6"), undefined);
  assert.equal(f.store.row("update:2:reply:0"), undefined);
  // A dead button inside the topic says so; one aimed at another topic is not this topic's business.
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
  // Every tap is still acknowledged, so Telegram never leaves a spinner behind.
  assert.ok(f.store.row("update:2:answer")); assert.ok(f.store.row("update:3:answer"));
  f.store.ingest([{update_id: 4, callback_query: {id: "real", from: {id: 9}, data,
    message: {message_id: 202, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  // Answering retires the whole offer: its buttons and its burst notice both go.
  assert.equal(f.store.get("repo-topic-notice:-42:5"), undefined);
  assert.equal(f.store.get("repo-topic-offer:-42:5"), undefined);
  assert.equal(f.store.get(data), undefined);
}));

test("a catalog outage retries the repo topic message instead of dropping or guessing it", () => fixture(async f => {
  f.api.listProjects = async () => { throw new Error("catalog unavailable"); };
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1")?.state, "pending");
  assert.match(f.store.row("update:1")?.error ?? "", /catalog unavailable/);
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'").get() as any).n, 0);
  // The failure must not count as the burst's one answer, or the retry would be silent.
  f.api.listProjects = async () => [{id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"}];
  f.store.retry("update:1", "retry", 0);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p1");
  assert.equal(JSON.parse(f.store.row("update:1:action")!.payload).projectId, "p1");
}));

test("a one-off /run in a linked repo topic stays a one-off and says where the topic still routes", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  for (const [i, text] of ["/run p1 one off", "/cloud p1 another one off"].entries()) {
    const id = i + 2;
    f.store.ingest([{update_id: id, message: {message_id: 100 + id, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text}}]);
    await processQueue(f.store, ["update"], row => commands.handle(row));
    assert.equal(JSON.parse(f.store.row(`update:${id}:action`)!.payload).projectId, "p1", text);
    assert.match(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.text, /one-off in repo \u00b7 org\/repo\. repo still routes to other \u00b7 org\/other/, text);
    // Naming a project for one task must never silently re-point every later message.
    assert.equal(f.store.get("repo-topic-project:-42:5"), "p2", text);
  }
  f.store.ingest([{update_id: 4, message: {message_id: 104, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "plain follow-up"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:4:action")!.payload).projectId, "p2");
}));

test("a repo topic whose project the catalog stops listing asks again and keeps its link", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.set("repo-topic-project:-42:5", "p-deleted");
  const before = (f.store.db.prepare("SELECT count(*) AS n FROM workspaces").get() as any).n;
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.row("update:1:action"), undefined);
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM workspaces").get() as any).n, before);
  // A stale or partial catalog read never deletes a link the owner confirmed, and never replaces it.
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p-deleted");
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /this catalog does not list/);
}));

test("a voice note in an unlinked repo topic is answered, never transcribed into a guess", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, voice: {file_id: "v1"}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM gateway_queue WHERE kind IN ('media','cloud')").get() as any).n, 0);
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /nothing sent here reaches Conductor yet/);
}));

test("a button from an offer the owner already answered cannot re-point the topic later", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const stale = JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.reply_markup.inline_keyboard[0][0].callback_data;
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link partner-api"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  // Scrollback is not a control surface: the superseded button reports itself instead of rebinding.
  f.store.ingest([{update_id: 3, callback_query: {id: "stale", from: {id: 9}, data: stale,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
}));

test("a message queued behind /link is answered instead of swallowed by its picker", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
  ];
  const commands = repoTopic(f, "api");
  // Both arrive in one batch, as they do after a restart or a Telegram backoff.
  f.store.ingest([1, 2].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, date: 1_700_000_000, text: n === 1 ? "/link" : "ship the release notes"}})));
  for (const _ of [1, 2]) await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.match(JSON.parse(f.store.row("update:1:bindtopic:0")!.payload).payload.text, /routes to no project yet/);
  assert.match(JSON.parse(f.store.row("update:2:bindtopic:0")!.payload).payload.text, /nothing sent here reaches Conductor yet/);
}));

test("a button dropped from a later offer stops working instead of re-pointing the topic", () => fixture(async f => {
  let catalog = [
    {id: "p1", name: "api", gitRemote: "git@github.com:org/api.git"},
    {id: "p2", name: "partner-api", gitRemote: "git@github.com:partner/api.git"},
    {id: "p3", name: "charlie", gitRemote: "git@github.com:org/charlie.git"},
    {id: "p4", name: "delta", gitRemote: "git@github.com:org/delta.git"},
  ];
  f.api.listProjects = async () => catalog;
  const commands = repoTopic(f, "api");
  const buttons = (id: number) => JSON.parse(f.store.row(`update:${id}:bindtopic:0`)!.payload)
    .payload.reply_markup.inline_keyboard.map((row: any[]) => row[0]);
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, date: 1_700_000_000, text: "ship it"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const dropped = buttons(1).find((b: any) => b.text.startsWith("delta")).callback_data;
  // A new project outranks delta alphabetically, so the next offer of four drops its button.
  catalog = [...catalog, {id: "p5", name: "aardvark", gitRemote: "git@github.com:org/aardvark.git"}];
  f.store.clear("projects");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, date: 1_700_000_060, text: "try again"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.ok(!buttons(2).some((b: any) => b.text.startsWith("delta")));
  assert.equal(f.store.get(dropped), undefined);
  f.store.ingest([{update_id: 3, callback_query: {id: "stale", from: {id: 9}, data: dropped,
    message: {message_id: 200, chat: {id: -42}, message_thread_id: 5}}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), undefined);
  assert.match(JSON.parse(f.store.row("update:3:answer")!.payload).payload.text, /no longer on the table/);
}));

test("every photo of an album follows the one-off project named in its caption", () => fixture(async f => {
  f.api.listProjects = async () => [
    {id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"},
    {id: "p2", name: "other", gitRemote: "git@github.com:org/other.git"},
  ];
  const commands = repoTopic(f, "repo");
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "/link other"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
  // Telegram delivers an album as one update per photo, with the caption on only the first.
  f.store.ingest([2, 3].map(n => ({update_id: n, message: {message_id: 100 + n, chat: {id: -42}, from: {id: 9},
    message_thread_id: 5, media_group_id: "album-1", photo: [{file_id: `photo-${n}`}],
    ...(n === 2 ? {caption: "/run p1 fix these two screens"} : {})}})));
  for (const _ of [2, 3]) await processQueue(f.store, ["update"], row => commands.handle(row));
  for (const id of [2, 3]) {
    assert.equal(JSON.parse(f.store.row(`update:${id}:action`)!.payload).projectId, "p1", `update ${id}`);
    assert.match(JSON.parse(f.store.row(`update:${id}:reply:0`)!.payload).payload.text, /one-off in repo \u00b7 org\/repo\. repo still routes to other \u00b7 org\/other/, `update ${id}`);
  }
  assert.equal(f.store.get("repo-topic-project:-42:5"), "p2");
}));

test("a repo topic an earlier release pinned to a workspace goes back to launching new work", () => fixture(async f => {
  f.api.listProjects = async () => [{id: "p1", name: "repo", gitRemote: "git@github.com:org/repo.git"}];
  const commands = repoTopic(f, "repo");
  // v0.8.1 pinned the workspace it launched to the repo topic's own thread.
  updateWorkspaceThreadId(f.ws.id, 5);
  await f.launch();
  assert.ok(f.store.binding(f.ws.id));
  f.store.ingest([{update_id: 1, message: {message_id: 101, chat: {id: -42}, from: {id: 9}, message_thread_id: 5, text: "start something new"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  const action = JSON.parse(f.store.row("update:1:action")!.payload);
  assert.equal(action.type, "launch");
  assert.notEqual(action.trackedId, f.ws.id);
  assert.equal(action.projectId, "p1");
  assert.equal(getWorkspace(action.trackedId)?.telegramThreadId, null);
  // Following up on the pinned workspace still works by replying to one of its messages.
  linkTelegramMessage("-42", "500", f.ws.id, "s1");
  f.store.ingest([{update_id: 2, message: {message_id: 102, chat: {id: -42}, from: {id: 9}, message_thread_id: 5,
    reply_to_message: {message_id: 500}, text: "keep going"}}]);
  await processQueue(f.store, ["update"], row => commands.handle(row));
  assert.equal(JSON.parse(f.store.row("update:2:action")!.payload).trackedId, f.ws.id);
}));
