import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDb, closeDb } from "../src/store/db.js";
import { archiveWorkspaceLocally, createDecision, createWorkspace, getDecision, getWorkspace, getWorkspaceMessageTarget,
  linkTelegramMessage, updateWorkspaceThreadId, upsertRepoTopic } from "../src/store/queries.js";
import { GatewayStore, type QueueRow } from "../src/cloud/store.js";
import { FileBridge } from "../src/cloud/bridge.js";
import { CloudEngine } from "../src/cloud/engine.js";
import { CloudGitHub } from "../src/cloud/catalog.js";
import { processQueue, type TelegramCall } from "../src/cloud/telegram.js";
import { type ConductorApiClient } from "../src/integrations/conductor-api.js";
import { ALBUM_JOIN_MS, ATTACHMENTS_ONLY_PROMPT, CloudCommands } from "../src/cloud/commands.js";

/** A forum group whose owner (user 9) talks to the gateway; Telegram's file API answers locally. */
async function fixture(fn: (f: ReturnType<typeof createFixture>) => Promise<void>): Promise<void> {
  const previousToken = process.env.BOT_TOKEN;
  const previousFetch = globalThis.fetch;
  process.env.BOT_TOKEN = "test-only-placeholder";
  // Every file downloads as its own file_id, so a test can tell which bytes landed where.
  globalThis.fetch = (async (url: string | URL | Request) => new Response(Buffer.from(String(url).split("/").pop()!))) as typeof fetch;
  const f = createFixture();
  try { await fn(f); } finally {
    closeDb(); rmSync(f.dir, { recursive: true, force: true });
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.BOT_TOKEN; else process.env.BOT_TOKEN = previousToken;
  }
}

function createFixture() {
  closeDb(); const dir = mkdtempSync(path.join(os.tmpdir(), "ct-albums-"));
  const store = new GatewayStore(getDb(path.join(dir, "state.db")));
  const bridge = new FileBridge(store, "http://127.0.0.1", path.join(dir, "files"));
  const api = { listProjects: async () => [{ id: "p1", name: "long-events", gitRemote: "git@github.com:org/long-events.git" }] };
  const engine = new CloudEngine(store, api as unknown as ConductorApiClient, bridge, new CloudGitHub("test"), undefined, true);
  const sizes: Record<string, number> = {};
  const getFile: TelegramCall = async (method, payload) => {
    assert.equal(method, "getFile");
    return { file_path: `photos/${payload.file_id}`, file_size: sizes[payload.file_id] ?? 10 };
  };
  const commands = new CloudCommands(store, engine, getFile, "-42", "9");
  commands.albumWaitMs = 0;
  let transcriptions = 0;
  commands.transcribe = async () => { transcriptions++; return "in long events the comparison page crashes"; };
  const updates = () => processQueue(store, ["update"], row => commands.handle(row));
  const media = () => processQueue(store, ["media"], row => commands.media(row));
  /** One update per photo of one album, as Telegram delivers it. */
  const album = (first: number, count: number, captions: Record<number, string> = {}, extra: Record<string, unknown> = {}) =>
    store.ingest(Array.from({ length: count }, (_, i) => ({ update_id: first + i, message: { message_id: 100 + first + i,
      chat: { id: -42 }, from: { id: 9 }, media_group_id: `album-${first}`, photo: [{ file_id: `thumb-${first + i}` }, { file_id: `photo-${first + i}` }],
      ...(captions[i] ? { caption: captions[i] } : {}), ...extra } })));
  const payload = (id: string) => JSON.parse(store.row(id)!.payload);
  const text = (id: string) => payload(id).payload.text as string;
  const count = (sql: string) => (store.db.prepare(sql).get() as { n: number }).n;
  return { dir, store, bridge, api, engine, commands, sizes, updates, media, album, payload, text, count, transcriptions: () => transcriptions };
}

/** A cloud workspace that owns a topic, as a finished launch leaves it. */
function boundWorkspace(f: ReturnType<typeof createFixture>, threadId: number) {
  const ws = createWorkspace({ name: "task", prompt: "Fix", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  updateWorkspaceThreadId(ws.id, threadId);
  f.store.bind(ws.id, { workspaceId: "w1", projectId: "p1", repoUrl: "git@github.com:org/long-events.git", repoSlug: "org/long-events",
    branch: null, prUrl: null, sessionId: "s1", agent: "claude", model: "fable-5-1", effort: "high", stopped: false });
  return ws;
}

test("an album captioned /run in General is one launch that carries every photo", () => fixture(async f => {
  f.album(1, 4, { 0: "/run long-events" });
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p1"); assert.equal(action.mediaPending, true);
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => file.fileName), ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg", "photo-4.jpg"]);
  assert.equal(f.text("update:1:reply:0"), "4 attachments received. Preparing them for Conductor.");
  // The other three updates are the same message: no refusal, no second workspace, no extra acknowledgement.
  for (const id of [2, 3, 4]) {
    assert.deepEqual(JSON.parse(f.store.row(`update:${id}`)!.result!), { absorbedInto: "update:1" });
    assert.equal(f.store.row(`update:${id}:reply:0`), undefined);
  }
  assert.equal(f.count("SELECT count(*) AS n FROM workspaces"), 1);
  assert.equal(getWorkspace(action.trackedId)?.name, "long-events: 4 attachments");
  // A reply to any photo of the album reaches the workspace it started.
  assert.equal(getWorkspaceMessageTarget("-42", "104")?.workspace.id, action.trackedId);

  await f.media();
  const released = f.payload("update:1:action");
  assert.equal(released.mediaPending, false);
  assert.equal(released.fileIds.length, 4);
  // Files sent without a word still reach the agent with an instruction.
  assert.equal(released.prompt, ATTACHMENTS_ONLY_PROMPT);
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, action.trackedId)?.name), ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg", "photo-4.jpg"]);

  // A lost processing receipt re-runs the job without saving any file twice.
  f.store.retry("update:1:media", "simulate lost processing receipt", 0);
  await f.media();
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_files"), 4);
  assert.deepEqual(f.payload("update:1:action").fileIds, released.fileIds);
}));

test("an album's caption counts wherever Telegram put it", () => fixture(async f => {
  f.album(1, 3, { 2: "/run long-events fix these screens" });
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.projectId, "p1");
  assert.equal(action.prompt, "fix these screens");
  assert.equal(f.payload("update:1:media").files.length, 3);
  assert.equal(getWorkspace(action.trackedId)?.name, "fix these screens");
}));

test("the first update of a fresh album waits in its lane until the rest arrive", () => fixture(async f => {
  f.commands.albumWaitMs = 60_000;
  f.album(1, 1, { 0: "/run long-events" });
  await f.updates();
  const leader = f.store.row("update:1")!;
  assert.equal(leader.state, "pending"); assert.equal(leader.error, "Collecting album");
  assert.equal(f.store.row("update:1:reply:0"), undefined);
  // The rest of the album lands in a later batch. The leader holds the lane, so nothing handles it alone.
  f.store.ingest([{ update_id: 2, message: { message_id: 102, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-2" }] } }]);
  await f.updates();
  assert.equal(f.store.row("update:2")!.state, "pending");
  f.commands.albumWaitMs = 0;
  f.store.db.prepare("UPDATE gateway_queue SET available_at=0 WHERE id='update:1'").run();
  await f.updates();
  assert.equal(f.payload("update:1:media").files.length, 2);
  assert.deepEqual(JSON.parse(f.store.row("update:2")!.result!), { absorbedInto: "update:1" });
}));

test("an album keeps every photo when its first update has to retry", () => fixture(async f => {
  upsertRepoTopic({ chatId: "-42", repoPath: "/Users/legacy/repos/long-events", repoName: "long-events", telegramThreadId: 5 });
  let outage = true;
  const listProjects = f.api.listProjects;
  f.api.listProjects = async () => { if (outage) throw new Error("catalog outage"); return listProjects(); };
  f.album(1, 3, {}, { message_thread_id: 5 });
  await f.updates();
  // The repo topic needed the catalog after the album was already collected.
  assert.equal(f.store.row("update:1")!.state, "pending");
  for (const id of [2, 3]) assert.equal(f.store.row(`update:${id}`)!.state, "done");
  outage = false;
  f.store.db.prepare("UPDATE gateway_queue SET available_at=0 WHERE id='update:1'").run();
  await f.updates();
  assert.equal(f.payload("update:1:action").projectId, "p1");
  assert.equal(f.payload("update:1:media").files.length, 3);
}));

test("a photo Telegram delivers after its album was handled joins the same work", () => fixture(async f => {
  f.album(1, 2, { 0: "/run long-events" });
  await f.updates();
  const started = f.payload("update:1:action");
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  const joined = f.payload("update:3:action");
  assert.equal(joined.type, "send"); assert.equal(joined.trackedId, started.trackedId);
  assert.equal(f.text("update:3:reply:0"), "Added to the same task.");
  assert.equal(f.payload("update:3:media").files.length, 1);
  assert.equal(f.count("SELECT count(*) AS n FROM workspaces"), 1);
  // A reply to the late photo reaches the same work as a reply to any other photo of the album.
  assert.equal(getWorkspaceMessageTarget("-42", "103")?.workspace.id, started.trackedId);
}));

test("a late photo whose album started nothing is told so, never guessed into new work", () => fixture(async f => {
  f.album(1, 2);
  await f.updates();
  assert.match(f.text("update:1:reply:0"), /Choose a workspace topic/);
  assert.equal(f.store.row("update:2:reply:0"), undefined);
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  assert.match(f.text("update:3:reply:0"), /arrived after the rest of its album/);
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_queue WHERE kind IN ('cloud','media')"), 0);
}));

test("an album never absorbs another sender's update", () => fixture(async f => {
  f.album(1, 1, { 0: "/run long-events" });
  f.store.ingest([{ update_id: 2, message: { message_id: 102, chat: { id: -42 }, from: { id: 10 }, media_group_id: "album-1", photo: [{ file_id: "stranger" }] } }]);
  await f.updates();
  assert.equal(f.payload("update:1:media").files.length, 1);
  await f.updates();
  assert.equal(f.store.row("update:2")!.result, "null");
  assert.equal(f.store.row("update:2:reply:0"), undefined);
}));

test("an album sent to a workspace topic is one follow-up with every photo", () => fixture(async f => {
  const ws = createWorkspace({ name: "task", prompt: "Fix", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  updateWorkspaceThreadId(ws.id, 7);
  f.store.bind(ws.id, { workspaceId: "w1", projectId: "p1", repoUrl: "git@github.com:org/long-events.git", repoSlug: "org/long-events",
    branch: null, prUrl: null, sessionId: "s1", agent: "claude", model: "fable-5-1", effort: "high", stopped: false });
  f.album(1, 3, { 1: "the footer overlaps here" }, { message_thread_id: 7 });
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.type, "send"); assert.equal(action.trackedId, ws.id);
  assert.equal(action.prompt, "the footer overlaps here");
  assert.equal(f.payload("update:1:media").files.length, 3);
  await f.media();
  assert.equal(f.payload("update:1:action").fileIds.length, 3);
  assert.equal(f.payload("update:1:action").prompt, "the footer overlaps here");
}));

test("a job queued before albums were grouped still prepares its one file", () => fixture(async f => {
  const ws = createWorkspace({ name: "task", prompt: "Fix", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  const action = { type: "send", trackedId: ws.id, prompt: "Look at this", statusId: "legacy:reply:0" };
  f.engine.queue("legacy:action", { ...action, mediaPending: true } as any);
  f.store.enqueue("media", "-42:0", { fileId: "photo-9", fileName: "photo.jpg", voice: false, chatId: "-42", action }, "legacy:media");
  await f.media();
  const released = f.payload("legacy:action");
  assert.equal(released.mediaPending, false);
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, ws.id)?.name), ["photo.jpg"]);
  assert.equal(f.store.get("media-file:legacy:media"), released.fileIds[0]);
}));

test("a file over Telegram's 20 MB bot limit is refused with the reason, whichever side notices", () => fixture(async f => {
  f.sizes["photo-1"] = 25 * 1024 * 1024;
  f.album(1, 1, { 0: "/run long-events" });
  await f.updates();
  await f.media();
  const blocked = f.store.row("update:1:media")!;
  assert.equal(blocked.state, "blocked"); assert.match(blocked.error!, /larger than the 20 MB Telegram lets bots download/);
  const tooBig: TelegramCall = async () => { throw { response: { error_code: 400, description: "Bad Request: file is too big" } }; };
  const commands = new CloudCommands(f.store, f.engine, tooBig, "-42", "9");
  f.store.ingest([{ update_id: 2, message: { message_id: 102, chat: { id: -42 }, from: { id: 9 }, caption: "/run long-events", document: { file_id: "huge", file_name: "huge.zip" } } }]);
  await processQueue(f.store, ["update"], (row: QueueRow) => commands.handle(row));
  await processQueue(f.store, ["media"], (row: QueueRow) => commands.media(row));
  assert.match(f.store.row("update:2:media")!.error!, /larger than the 20 MB/);
}));

test("a voice note is transcribed once, however often its job retries", () => fixture(async f => {
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, caption: "/run long-events", voice: { file_id: "voice-1" } } }]);
  await f.updates();
  await f.media();
  assert.equal(f.payload("update:1:action").prompt, "in long events the comparison page crashes");
  f.store.retry("update:1:media", "simulate lost processing receipt", 0);
  await f.media();
  assert.equal(f.transcriptions(), 1);
  assert.equal(f.payload("update:1:action").prompt, "in long events the comparison page crashes");
}));

test("a voice note in General is transcribed, then routed for confirmation with its words", () => fixture(async f => {
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, voice: { file_id: "voice-1" } } }]);
  await f.updates();
  assert.equal(f.text("update:1:reply:0"), "Voice note received. Transcribing it before target confirmation.");
  assert.deepEqual(f.payload("update:1:media").files, [{ fileId: "voice-1", voice: true, fileName: "voice.ogg" }]);
  await f.media();
  // Nothing names a target yet, so the words go to the router rather than into any workspace.
  assert.deepEqual(f.payload("update:1:media:route"), { text: "in long events the comparison page crashes", chatId: "-42", statusId: "update:1:reply:0" });
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_queue WHERE kind='cloud'"), 0);
}));

test("jobs queued before albums were grouped still route a voice note and save a file", () => fixture(async f => {
  // A voice note sent to General before the upgrade: no target yet, its one file inline.
  f.store.enqueue("media", "-42:0", { fileId: "voice-7", fileName: "voice.ogg", voice: true, text: "", chatId: "-42", statusId: "legacy-voice:reply:0" }, "legacy-voice:media");
  // A file whose job recorded no name.
  const ws = createWorkspace({ name: "task", prompt: "Fix", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  const action = { type: "send", trackedId: ws.id, prompt: "", statusId: "legacy-doc:reply:0" };
  f.engine.queue("legacy-doc:action", { ...action, mediaPending: true } as any);
  f.store.enqueue("media", "-42:9", { fileId: "doc-7", chatId: "-42", threadId: 9, action }, "legacy-doc:media");
  await f.media();
  assert.equal(f.payload("legacy-voice:media:route").text, "in long events the comparison page crashes");
  const released = f.payload("legacy-doc:action");
  assert.equal(released.mediaPending, false);
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, ws.id)?.name), ["attachment"]);
  assert.equal(released.prompt, ATTACHMENTS_ONLY_PROMPT);
}));

test("an album sent as the answer to a question records one answer with every file", () => fixture(async f => {
  const ws = createWorkspace({ name: "task", prompt: "Fix", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  const decisionId = createDecision(ws.id, "Which screen is broken?", null);
  f.store.linkDecision("-42", 100, decisionId);
  f.album(1, 2, {}, { reply_to_message: { message_id: 100 } });
  await f.updates();
  assert.equal(f.text("update:1:reply:0"), "Answer received. Preparing the attachment.");
  assert.deepEqual(JSON.parse(f.store.row("update:2")!.result!), { absorbedInto: "update:1" });
  assert.equal(f.payload("update:1:media").files.length, 2);
  await f.media();
  const answer = getDecision(decisionId)!.answer!;
  const lines = answer.split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) assert.match(line, /^Attachment [\w-]+: http:\/\/127\.0\.0\.1\/v1\/attachments\/[\w-]+\?token=[\w-]+$/);
  // An answer carries only what the owner sent, never the instruction written for a bare task.
  assert.doesNotMatch(answer, /without instructions/);
  assert.equal(f.text("update:1:media:answered:0"), "Answer recorded.");
  assert.equal(f.store.row("update:1:action"), undefined);
}));

test("a lone photo sent without a word to a workspace topic reaches the agent with an instruction", () => fixture(async f => {
  const ws = boundWorkspace(f, 7);
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    photo: [{ file_id: "thumb-1" }, { file_id: "photo-1" }] } }]);
  await f.updates();
  assert.equal(f.text("update:1:reply:0"), "Attachment received. Preparing it for Conductor.");
  // A photo on its own keeps the name it always had; only an album numbers its photos.
  assert.deepEqual(f.payload("update:1:media").files, [{ fileId: "photo-1", voice: false, fileName: "photo.jpg" }]);
  await f.media();
  const released = f.payload("update:1:action");
  assert.equal(released.type, "send"); assert.equal(released.trackedId, ws.id); assert.equal(released.mediaPending, false);
  assert.equal(released.prompt, ATTACHMENTS_ONLY_PROMPT);
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, ws.id)?.name), ["photo.jpg"]);
}));

test("/run with one file and no task names the workspace for a single attachment", () => fixture(async f => {
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, caption: "/run long-events",
    document: { file_id: "doc-1", file_name: "crash-log.txt" } } }]);
  await f.updates();
  assert.equal(getWorkspace(f.payload("update:1:action").trackedId)?.name, "long-events: 1 attachment");
  assert.equal(f.text("update:1:reply:0"), "Attachment received. Preparing it for Conductor.");
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => file.fileName), ["crash-log.txt"]);
}));

test("an uncaptioned album in a linked repo topic launches one workspace named for its project", () => fixture(async f => {
  upsertRepoTopic({ chatId: "-42", repoPath: "/Users/legacy/repos/long-events", repoName: "long-events", telegramThreadId: 5 });
  f.store.set("repo-topic-project:-42:5", "p1");
  f.album(1, 2, {}, { message_thread_id: 5 });
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p1");
  const ws = getWorkspace(action.trackedId)!;
  assert.equal(ws.name, "long-events: 2 attachments");
  // The album's workspace lives in the topic it was sent from: one topic, one workspace.
  assert.equal(ws.telegramThreadId, 5);
  assert.match(f.text("update:1:reply:0"), /^2 attachments received\. Preparing them for Conductor\./);
  assert.deepEqual(JSON.parse(f.store.row("update:2")!.result!), { absorbedInto: "update:1" });
}));

test("two albums sent back to back stay two tasks, each with only its own photos", () => fixture(async f => {
  f.album(1, 2, { 0: "/run long-events fix the header" });
  f.album(3, 3, { 0: "/run long-events fix the footer" });
  await f.updates();
  await f.updates();
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => file.fileId), ["photo-1", "photo-2"]);
  assert.deepEqual(f.payload("update:3:media").files.map((file: any) => file.fileId), ["photo-3", "photo-4", "photo-5"]);
  assert.deepEqual(JSON.parse(f.store.row("update:2")!.result!), { absorbedInto: "update:1" });
  for (const id of [4, 5]) assert.deepEqual(JSON.parse(f.store.row(`update:${id}`)!.result!), { absorbedInto: "update:3" });
  assert.deepEqual((f.store.db.prepare("SELECT name FROM workspaces ORDER BY name").all() as Array<{ name: string }>).map(row => row.name),
    ["fix the footer", "fix the header"]);
}));

test("a photo that arrives after its album's workspace was archived is told so, never sent into retired work", () => fixture(async f => {
  f.album(1, 2, { 0: "/run long-events" });
  await f.updates();
  archiveWorkspaceLocally(f.payload("update:1:action").trackedId);
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  assert.match(f.text("update:3:reply:0"), /arrived after the rest of its album/);
  assert.equal(f.store.row("update:3:action"), undefined);
  assert.equal(f.store.row("update:3:media"), undefined);
}));

test("a photo that lands while its album's first update waits to retry joins that update", () => fixture(async f => {
  upsertRepoTopic({ chatId: "-42", repoPath: "/Users/legacy/repos/long-events", repoName: "long-events", telegramThreadId: 5 });
  let outage = true;
  const listProjects = f.api.listProjects;
  f.api.listProjects = async () => { if (outage) throw new Error("catalog outage"); return listProjects(); };
  f.album(1, 2, {}, { message_thread_id: 5 });
  await f.updates();
  assert.equal(f.store.row("update:1")!.state, "pending");
  // Telegram hands over the album's last photo while its first update is still waiting in the lane.
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 5,
    media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  outage = false;
  f.store.db.prepare("UPDATE gateway_queue SET available_at=0 WHERE id='update:1'").run();
  await f.updates();
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => [file.fileId, file.fileName]),
    [["photo-1", "photo-1.jpg"], ["photo-2", "photo-2.jpg"], ["photo-3", "photo-3.jpg"]]);
  assert.deepEqual(JSON.parse(f.store.row("update:3")!.result!), { absorbedInto: "update:1" });
  assert.equal(f.store.row("update:3:reply:0"), undefined);
  assert.equal(f.count("SELECT count(*) AS n FROM workspaces"), 1);
  // The topic linked itself to its one matching project, and the workspace is named for it.
  assert.equal(getWorkspace(f.payload("update:1:action").trackedId)?.name, "long-events: 3 attachments");
}));

test("a late item of an album that opened a new thread joins that thread's workspace", () => fixture(async f => {
  const ws = boundWorkspace(f, 7);
  f.album(1, 2, { 0: "/threads new compare these" }, { message_thread_id: 7 });
  await f.updates();
  assert.equal(f.payload("update:1:action").type, "thread");
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  const joined = f.payload("update:3:action");
  assert.equal(joined.type, "send"); assert.equal(joined.trackedId, ws.id);
  assert.equal(f.text("update:3:reply:0"), "Added to the same task.");
  // An album of videos carries no file the gateway takes, so its thread is queued under its own id. A late caption still finds it.
  const clip = (n: number, extra: Record<string, unknown> = {}) => ({ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 },
    message_thread_id: 7, media_group_id: "clips", video: { file_id: `clip-${n}` }, ...extra } });
  f.store.ingest([clip(4, { caption: "/threads new check the recordings" }), clip(5)]);
  await f.updates();
  assert.equal(f.payload("update:4:thread").type, "thread");
  f.store.ingest([clip(6, { caption: "the last clip shows it best" })]);
  await f.updates();
  const followUp = f.payload("update:6:action");
  assert.equal(followUp.type, "send"); assert.equal(followUp.trackedId, ws.id);
  assert.equal(followUp.prompt, "the last clip shows it best");
}));

test("every caption in an album reaches its task, and each file keeps its own name", () => fixture(async f => {
  f.store.ingest([1, 2, 3].map(n => ({ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 }, media_group_id: "reports",
    document: { file_id: `doc-${n}`, file_name: `report-${n}.pdf` },
    ...(n === 1 ? { caption: "/run long-events compare these reports" } : n === 3 ? { caption: "the last one is the newest" } : {}) } })));
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.prompt, "compare these reports\n\nthe last one is the newest");
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => file.fileName), ["report-1.pdf", "report-2.pdf", "report-3.pdf"]);
  await f.media();
  const released = f.payload("update:1:action");
  assert.equal(released.prompt, "compare these reports\n\nthe last one is the newest");
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, action.trackedId)?.name), ["report-1.pdf", "report-2.pdf", "report-3.pdf"]);
}));

test("an album routed for confirmation brings every file to the confirmed task", () => fixture(async f => {
  f.album(1, 2, { 1: "fix these screens" });
  await f.updates();
  assert.match(f.text("update:1:reply:0"), /Finding a target/);
  const routed = f.payload("update:1:route");
  assert.equal(routed.text, "fix these screens");
  assert.deepEqual(routed.media.files.map((file: any) => file.fileId), ["photo-1", "photo-2"]);
  const ws = createWorkspace({ name: "fix these screens", prompt: "fix these screens", repoPath: "conductor-project:p1", telegramChatId: "-42" });
  // The router's proposal for this album, and one proposed before albums were grouped, whose media carries its one file inline.
  f.store.set("route:album", { chatId: "-42", media: routed.media, action: { type: "launch", trackedId: ws.id, projectId: "p1", prompt: "fix these screens" } });
  f.store.set("route:legacy", { chatId: "-42", media: { fileId: "photo-9", fileName: "photo.jpg", voice: false, chatId: "-42" },
    action: { type: "send", trackedId: ws.id, prompt: "and this one" } });
  f.store.ingest(["album", "legacy"].map((key, i) => ({ update_id: 10 + i, callback_query: { id: `confirm-${key}`, from: { id: 9 }, data: `route:${key}`,
    message: { message_id: 500 + i, chat: { id: -42 }, from: { id: 99, is_bot: true }, text: "Start this task?" } } })));
  await f.updates(); await f.updates();
  await f.media(); await f.media();
  const album = f.payload("route:album:confirmed:action");
  assert.equal(album.mediaPending, false); assert.equal(album.prompt, "fix these screens");
  assert.deepEqual(album.fileIds.map((id: string) => f.bridge.file(id, ws.id)?.name), ["photo-1.jpg", "photo-2.jpg"]);
  const legacy = f.payload("route:legacy:confirmed:action");
  assert.equal(legacy.mediaPending, false); assert.equal(legacy.prompt, "and this one");
  assert.deepEqual(legacy.fileIds.map((id: string) => f.bridge.file(id, ws.id)?.name), ["photo.jpg"]);
}));

test("an album whose download fails partway resumes without fetching or saving a file twice", () => fixture(async f => {
  const calls: string[] = [];
  const failures: unknown[] = [
    { response: { error_code: 429, description: "Too Many Requests: retry after 3", parameters: { retry_after: 3 } } },
    new Error("socket hang up"),
  ];
  const flaky: TelegramCall = async (_method, payload) => {
    calls.push(payload.file_id);
    if (payload.file_id === "photo-2" && failures.length) throw failures.shift();
    return { file_path: `photos/${payload.file_id}`, file_size: 10 };
  };
  const commands = new CloudCommands(f.store, f.engine, flaky, "-42", "9");
  commands.albumWaitMs = 0;
  const media = () => processQueue(f.store, ["media"], (row: QueueRow) => commands.media(row));
  f.album(1, 3, { 0: "/run long-events" });
  await processQueue(f.store, ["update"], (row: QueueRow) => commands.handle(row));
  await media();
  // Telegram's rate limit holds every later call back; it is never mistaken for a broken file.
  let job = f.store.row("update:1:media")!;
  assert.equal(job.state, "pending");
  assert.ok((f.store.get<number>("telegram-not-before") ?? 0) > Date.now() + 2_000);
  f.store.set("telegram-not-before", 0);
  f.store.retry("update:1:media", "retry now", 0);
  await media();
  job = f.store.row("update:1:media")!;
  assert.equal(job.state, "pending"); assert.equal(job.error, "socket hang up");
  assert.equal(f.payload("update:1:action").mediaPending, true);
  f.store.retry("update:1:media", "retry now", 0);
  await media();
  const released = f.payload("update:1:action");
  assert.equal(released.mediaPending, false);
  assert.deepEqual(released.fileIds.map((id: string) => f.bridge.file(id, released.trackedId)?.name), ["photo-1.jpg", "photo-2.jpg", "photo-3.jpg"]);
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_files"), 3);
  // The album's files are fetched together, so one failing file never re-fetches the ones that succeeded.
  assert.deepEqual(calls, ["photo-1", "photo-2", "photo-3", "photo-2", "photo-2"]);
}));

test("a download blocks at once only when retrying cannot help", () => fixture(async f => {
  const noPath: TelegramCall = async () => ({ file_size: 10 });
  const commands = new CloudCommands(f.store, f.engine, noPath, "-42", "9");
  const run = (n: number) => f.store.ingest([{ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 },
    caption: "/run long-events", photo: [{ file_id: `photo-${n}` }] } }]);
  run(1);
  await processQueue(f.store, ["update"], (row: QueueRow) => commands.handle(row));
  await processQueue(f.store, ["media"], (row: QueueRow) => commands.media(row));
  assert.equal(f.store.row("update:1:media")!.state, "blocked");
  assert.equal(f.store.row("update:1:media")!.error, "Telegram file unavailable");

  delete process.env.BOT_TOKEN;
  run(2);
  await f.updates(); await f.media();
  assert.equal(f.store.row("update:2:media")!.state, "blocked");
  assert.equal(f.store.row("update:2:media")!.error, "Telegram credentials missing");

  // A server error while downloading can pass, so it retries instead of blocking.
  process.env.BOT_TOKEN = "test-only-placeholder";
  globalThis.fetch = (async () => new Response("unavailable", { status: 502 })) as typeof fetch;
  run(3);
  await f.updates(); await f.media();
  const outage = f.store.row("update:3:media")!;
  assert.equal(outage.state, "pending"); assert.equal(outage.error, "Telegram file download failed (502)");
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_files"), 0);
}));

test("a file that proves larger than 20 MB mid-download blocks its whole album instead of sending part of it", () => fixture(async f => {
  // Telegram reports a size right at the limit, so only the bytes themselves can show this file is too large.
  f.sizes["doc-2"] = 20 * 1024 * 1024;
  const fetched: string[] = [];
  const serve = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const name = String(url).split("/").pop()!;
    fetched.push(name);
    if (name !== "doc-2") return serve(url);
    let chunks = 0;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (chunks++ < 21) controller.enqueue(new Uint8Array(1024 * 1024)); else controller.close();
    } }));
  }) as typeof fetch;
  f.store.ingest([1, 2].map(n => ({ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 }, media_group_id: "exports",
    document: { file_id: `doc-${n}`, file_name: `export-${n}.csv` }, ...(n === 1 ? { caption: "/run long-events import these" } : {}) } })));
  await f.updates();
  await f.media();
  const blocked = f.store.row("update:1:media")!;
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.error!, /larger than the 20 MB Telegram lets bots download/);
  assert.deepEqual(fetched, ["doc-1", "doc-2"]);
  // No file of the album reaches the agent without the rest, and the turn reports why.
  assert.equal(f.payload("update:1:action").mediaPending, true);
  await processQueue(f.store, ["cloud"], (row: QueueRow) => f.engine.action(row));
  const action = f.store.row("update:1:action")!;
  assert.equal(action.state, "blocked"); assert.match(action.error!, /Attachment preparation failed/);
}));

test("a voice note Whisper cannot transcribe blocks with the reason and is never cached as silence", () => fixture(async f => {
  const outcomes: Array<() => string | null> = [() => { throw new Error("whisper crashed"); }, () => null];
  f.commands.transcribe = async () => outcomes.shift()!();
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, caption: "/run long-events", voice: { file_id: "voice-1" } } }]);
  await f.updates();
  // A voice note's words arrive later, so its workspace is not named as a pile of attachments.
  assert.equal(getWorkspace(f.payload("update:1:action").trackedId)?.name, "Telegram task");
  const local = path.join(os.tmpdir(), `ct-voice-${createHash("sha256").update("update:1:media:0").digest("hex")}`);
  await f.media();
  let job = f.store.row("update:1:media")!;
  assert.equal(job.state, "pending"); assert.equal(job.error, "whisper crashed");
  assert.equal(existsSync(local), false);
  f.store.retry("update:1:media", "retry now", 0);
  await f.media();
  job = f.store.row("update:1:media")!;
  assert.equal(job.state, "blocked"); assert.equal(job.error, "Voice transcription failed. Please retry or send text.");
  assert.equal(existsSync(local), false);
  assert.equal(f.store.get("media-transcript:update:1:media:0"), undefined);
  assert.equal(f.payload("update:1:action").mediaPending, true);
}));

test("an album's first update pauses after each arrival and stops once the album is quiet", () => fixture(async f => {
  f.commands.albumWaitMs = 60_000;
  f.commands.albumSettleMs = 250;
  f.album(1, 2, { 0: "/run long-events" });
  await f.updates();
  const waiting = f.store.row("update:1")!;
  assert.equal(waiting.state, "pending"); assert.equal(waiting.error, "Collecting album");
  // It pauses one settle interval for more of the album, never the whole window.
  assert.ok(waiting.available_at - Date.now() <= 250, `paused ${waiting.available_at - Date.now()} ms`);
  assert.equal(f.store.get<any[]>("album-members:update:1")!.length, 1, "the photo already waiting is held, not re-read");
  assert.equal(f.store.row("update:1:action"), undefined);
  // Nothing more arrives, so the next pass handles the album instead of waiting again.
  f.store.db.prepare("UPDATE gateway_queue SET available_at=0 WHERE id='update:1'").run();
  await f.updates();
  assert.equal(f.payload("update:1:media").files.length, 2);
  assert.equal(f.store.row("update:1")!.state, "done");
}));

test("an album stops waiting when its window closes, however slowly Telegram delivers it", () => fixture(async f => {
  f.commands.albumWaitMs = 1500;
  f.commands.albumSettleMs = 250;
  f.album(1, 1, { 0: "/run long-events" });
  await f.updates();
  assert.equal(f.store.row("update:1")!.state, "pending");
  // The window closes with nothing else delivered: the album is handled with what it has.
  f.store.db.prepare("UPDATE gateway_queue SET created_at=created_at-2000, available_at=0 WHERE id='update:1'").run();
  await f.updates();
  assert.equal(f.payload("update:1:media").files.length, 1);
}));

test("a late photo of an album that replied to one thread joins that same thread", () => fixture(async f => {
  const ws = boundWorkspace(f, 7);
  linkTelegramMessage("-42", "1000", ws.id, "s-old");
  f.album(1, 2, { 0: "compare with yesterday" }, { message_thread_id: 7, reply_to_message: { message_id: 1000 } });
  await f.updates();
  assert.equal(f.payload("update:1:action").sessionId, "s-old");
  // The late photo does not quote the message itself; only its album knows which thread it answered.
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  const joined = f.payload("update:3:action");
  assert.equal(joined.trackedId, ws.id); assert.equal(joined.sessionId, "s-old");
}));

test("an album of audio files is transcribed file by file, after its caption, and only once", () => fixture(async f => {
  const heard: string[] = [];
  f.commands.transcribe = async voicePath => { const bytes = readFileSync(voicePath, "utf8"); heard.push(bytes); return `heard ${bytes}`; };
  f.store.ingest([1, 2].map(n => ({ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 }, media_group_id: "memos",
    audio: { file_id: `memo-${n}`, file_name: `memo-${n}.m4a` }, ...(n === 1 ? { caption: "/run long-events follow these notes" } : {}) } })));
  await f.updates();
  assert.equal(f.payload("update:1:media").files.every((file: any) => file.voice), true);
  await f.media();
  const released = f.payload("update:1:action");
  assert.equal(released.mediaPending, false);
  assert.equal(released.prompt, "follow these notes\n\nheard memo-1\n\nheard memo-2");
  assert.equal(released.fileIds, undefined);
  f.store.retry("update:1:media", "simulate lost processing receipt", 0);
  await f.media();
  assert.deepEqual(heard, ["memo-1", "memo-2"]);
  assert.equal(f.payload("update:1:action").prompt, "follow these notes\n\nheard memo-1\n\nheard memo-2");
}));

test("a file whose job names no target blocks with the reason before anything is downloaded", () => fixture(async f => {
  const asked: string[] = [];
  const commands = new CloudCommands(f.store, f.engine, async (_method, payload) => { asked.push(payload.file_id); return { file_path: "photos/x", file_size: 10 }; }, "-42", "9");
  f.store.enqueue("media", "-42:0", { files: [{ fileId: "photo-1", fileName: "photo.jpg", voice: false }], chatId: "-42", text: "" }, "orphan:media");
  await processQueue(f.store, ["media"], (row: QueueRow) => commands.media(row));
  const job = f.store.row("orphan:media")!;
  assert.equal(job.state, "blocked"); assert.equal(job.error, "Choose a workspace before sending this file");
  assert.deepEqual(asked, []);
  assert.equal(f.store.row("orphan:media:route"), undefined);
}));

test("a review sent with only a screenshot keeps its own instructions", () => fixture(async f => {
  const ws = boundWorkspace(f, 7);
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    caption: "/review", photo: [{ file_id: "photo-1" }] } }]);
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.type, "review"); assert.equal(action.trackedId, ws.id);
  await f.media();
  const released = f.payload("update:1:action");
  assert.equal(released.fileIds.length, 1);
  assert.equal(released.prompt, "");
}));

test("a document Telegram sends without a file name is saved as an attachment, never as a voice note", () => fixture(async f => {
  boundWorkspace(f, 7);
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    document: { file_id: "doc-1" } } }]);
  await f.updates();
  assert.deepEqual(f.payload("update:1:media").files, [{ fileId: "doc-1", voice: false, fileName: "attachment" }]);
}));

test("an album's command is obeyed wherever its captions put it", () => fixture(async f => {
  f.album(1, 2, { 0: "here are two screens", 1: "/run long-events fix these" });
  await f.updates();
  const action = f.payload("update:1:action");
  assert.equal(action.type, "launch"); assert.equal(action.projectId, "p1");
  // The command runs, and the other caption is still part of the task.
  assert.equal(action.prompt, "fix these\n\nhere are two screens");
  assert.equal(f.store.row("update:1:route"), undefined);
}));

test("a queued attachment stays readable by a release that knows only one file per job", () => fixture(async f => {
  f.album(1, 3, { 0: "/run long-events" });
  await f.updates();
  const job = f.payload("update:1:media");
  // A rollback reads the inline first file; this release reads the array.
  assert.deepEqual({ fileId: job.fileId, fileName: job.fileName, voice: job.voice }, { fileId: "photo-1", fileName: "photo-1.jpg", voice: false });
  assert.deepEqual(job.files[0], { fileId: "photo-1", fileName: "photo-1.jpg", voice: false });
  assert.equal(job.files.length, 3);
}));

test("an album never absorbs a sibling from another topic or one already being handled", () => fixture(async f => {
  f.album(1, 1, { 0: "/run long-events" });
  // Same album id, but another topic: a different lane, which this leader does not fence.
  f.store.ingest([{ update_id: 2, message: { message_id: 102, chat: { id: -42 }, from: { id: 9 }, message_thread_id: 7,
    media_group_id: "album-1", photo: [{ file_id: "photo-2" }] } }]);
  // And one in this lane that another worker already claimed.
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  f.store.db.prepare("UPDATE gateway_queue SET state='running' WHERE id='update:3'").run();
  await f.updates();
  assert.equal(f.payload("update:1:media").files.length, 1);
  // Neither was closed as part of this album: the other topic answered for itself, and the claimed row is untouched.
  assert.equal(f.store.row("update:2")!.result, "null");
  assert.ok(f.store.row("update:2:reply:0"));
  assert.equal(f.store.row("update:3")!.state, "running");
  assert.equal(f.store.row("update:3")!.result, null);
}));
test("a late photo is refused when its album never reached Conductor", () => fixture(async f => {
  f.sizes["photo-1"] = 25 * 1024 * 1024;
  f.album(1, 2, { 0: "/run long-events" });
  await f.updates();
  await f.media();
  await processQueue(f.store, ["cloud"], row => f.engine.action(row));
  assert.equal(f.store.row("update:1:action")!.state, "blocked");
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  assert.match(f.text("update:3:reply:0"), /arrived after the rest of its album/);
  assert.equal(f.store.row("update:3:action"), undefined);
}));

test("a photo of an album from long ago starts fresh instead of joining it", () => fixture(async f => {
  f.album(1, 2, { 0: "/run long-events" });
  await f.updates();
  f.store.set("album:-42:album-1", { ...f.store.get<any>("album:-42:album-1"), at: Date.now() - ALBUM_JOIN_MS - 1 });
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  assert.match(f.text("update:3:reply:0"), /arrived after the rest of its album/);
}));

test("album bookkeeping and voice transcripts are swept once their turn is over, never before", () => fixture(async f => {
  f.commands.albumWaitMs = 60_000;
  f.store.ingest([{ update_id: 1, message: { message_id: 101, chat: { id: -42 }, from: { id: 9 }, caption: "/run long-events", voice: { file_id: "voice-1" } } }]);
  await f.updates(); await f.media();
  f.album(2, 2, { 0: "/run long-events" });
  await f.updates();
  const transcripts = () => f.count("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'media-transcript:%'");
  const members = () => f.count("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'album-members:%'");
  assert.equal(transcripts(), 1); assert.equal(members(), 1);
  // Both turns can still run again — the leader is settling, the voice job has a lost receipt — so nothing is swept.
  f.store.retry("update:1:media", "simulate a lost receipt", 0);
  f.store.pruneTurnState(ALBUM_JOIN_MS);
  assert.equal(transcripts(), 1, "a transcript outlives its own retry, so Whisper never runs twice");
  assert.equal(members(), 1, "an album's photos outlive the leader's retry");
  // Both turns finish.
  await f.media();
  f.store.db.prepare("UPDATE gateway_queue SET available_at=0 WHERE id='update:2'").run();
  f.commands.albumWaitMs = 0;
  await f.updates();
  assert.equal(f.payload("update:2:media").files.length, 2);
  await f.media();
  f.store.pruneTurnState(ALBUM_JOIN_MS);
  assert.equal(transcripts(), 0); assert.equal(members(), 0);
  // The album stays joinable, and the attachment IDs its files were saved under are never swept.
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'album:%'"), 1);
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'media-file:%'"), 2);
  f.store.pruneTurnState(ALBUM_JOIN_MS, Date.now() + ALBUM_JOIN_MS + 1);
  assert.equal(f.count("SELECT count(*) AS n FROM gateway_state WHERE key LIKE 'album:%'"), 0);
}));
test("an album of documents Telegram does not name keeps one name per file", () => fixture(async f => {
  f.store.ingest([1, 2].map(n => ({ update_id: n, message: { message_id: 100 + n, chat: { id: -42 }, from: { id: 9 },
    media_group_id: "album-docs", document: { file_id: `doc-${n}` }, ...(n === 1 ? { caption: "/run long-events" } : {}) } })));
  await f.updates();
  assert.deepEqual(f.payload("update:1:media").files.map((file: any) => file.fileName), ["attachment-1", "attachment-2"]);
}));

test("a late photo waits for the album's own task to exist, rather than joining an unconfirmed one", () => fixture(async f => {
  // A caption with no command in General goes to the router, which only proposes work until the owner confirms.
  f.album(1, 2, { 0: "fix these screens" });
  await f.updates();
  assert.ok(f.store.row("update:1:route"));
  f.store.ingest([{ update_id: 3, message: { message_id: 103, chat: { id: -42 }, from: { id: 9 }, media_group_id: "album-1", photo: [{ file_id: "photo-3" }] } }]);
  await f.updates();
  // Nothing is queued against work that may never start; the owner is told to send it again.
  assert.match(f.text("update:3:reply:0"), /arrived after the rest of its album/);
  assert.equal(f.store.row("update:3:action"), undefined);
  assert.equal(f.store.row("update:3:media"), undefined);
}));
