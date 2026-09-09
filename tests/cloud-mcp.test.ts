import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {once} from "node:events";
import path from "node:path";
import os from "node:os";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {getDb, closeDb} from "../src/store/db.js";
import {createWorkspace} from "../src/store/queries.js";
import {GatewayStore} from "../src/cloud/store.js";
import {FileBridge, startBridge} from "../src/cloud/bridge.js";
import {CloudEngine} from "../src/cloud/engine.js";
import {CloudGitHub} from "../src/cloud/catalog.js";
import {CloudCommands} from "../src/cloud/commands.js";
import {processQueue, TelegramDelivery} from "../src/cloud/telegram.js";
import type {ConductorApiClient} from "../src/integrations/conductor-api.js";

test("real stdio MCP talks to the scoped HTTP bridge, exchanges a file, and consumes a durable Telegram question reply", async () => {
  closeDb(); const root = mkdtempSync(path.join(os.tmpdir(), "ct-mcp-http-"));
  const store = new GatewayStore(getDb(path.join(root, "gateway.db")));
  const ws = createWorkspace({name: "cloud", prompt: "test", repoPath: "conductor-project:test", telegramChatId: "42"});
  const bridge = new FileBridge(store, "http://127.0.0.1", path.join(root, "attachments"));
  const server = startBridge(bridge, 0); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const token = bridge.issueCredential(ws.id);
  const client = new Client({name: "test", version: "1"});
  const transport = new StdioClientTransport({command: process.execPath,
    args: ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/mcp/remote-entry.ts", import.meta.url))],
    cwd: root, env: {TELEGRAM_BRIDGE_URL: origin, TELEGRAM_BRIDGE_TOKEN: token, DB_PATH: "/unavailable/no-shared-database", PATH: process.env.PATH ?? ""}, stderr: "pipe"});
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(t => t.name);
    assert.ok(names.includes("request_human") && names.includes("refresh_attachment"));
    await client.callTool({name: "report_status", arguments: {status: "running", message: "Progress over HTTP"}});
    writeFileSync(path.join(root, "artifact.txt"), "Bidirectional file proof");
    const artifact = await client.callTool({name: "report_artifact", arguments: {type: "file", url: "artifact.txt", description: "Test artifact"}});
    assert.equal(artifact.isError, undefined);
    const file = store.db.prepare("SELECT id,path FROM gateway_files").get() as any;
    assert.equal(readFileSync(file.path, "utf8"), "Bidirectional file proof");
    const refreshed = await fetch(`${origin}/v1/attachments/${file.id}`, {method: "POST", headers: {Authorization: `Bearer ${token}`}});
    const link = new URL((await refreshed.json() as any).url); link.port = String((server.address() as any).port);
    assert.equal(await (await fetch(link)).text(), "Bidirectional file proof");
    const pending = client.callTool({name: "request_human", arguments: {question: "Continue this test?", options: ["Proceed", "Stop"]}});
    const until = Date.now() + 5000;
    while (!store.db.prepare("SELECT 1 FROM decisions").get() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(store.db.prepare("SELECT 1 FROM decisions").get());
    const engine = new CloudEngine(store, {} as ConductorApiClient, bridge, new CloudGitHub("unused"));
    engine.events();
    const sender = new TelegramDelivery(store, async () => ({message_id: 101}));
    await sender.tick(); // Question is reconstructed before status/file events.
    assert.ok(store.decisionForMessage("42", 101));
    const restarted = new GatewayStore(store.db);
    const commands = new CloudCommands(restarted, engine, async () => ({}), "42", "9");
    restarted.ingest([{update_id: 1, message: {message_id: 102, chat: {id: 42}, from: {id: 9}, reply_to_message: {message_id: 101}, text: "Proceed"}}]);
    await processQueue(restarted, ["update"], row => commands.handle(row));
    const result = await pending;
    assert.match(JSON.stringify(result), /Human responded: Proceed/);
    writeFileSync(path.join(root, ".env.production"), "private");
    const denied = await client.callTool({name: "report_artifact", arguments: {type: "file", url: ".env.production", description: "should reject"}});
    assert.equal(denied.isError, true);
  } finally {
    await client.close(); await transport.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    closeDb(); rmSync(root, {recursive: true, force: true});
  }
});
