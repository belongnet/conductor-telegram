import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export class RemoteBridgeClient {
  constructor(readonly baseUrl: string, private readonly token: string, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Bridge requires HTTPS");
    if (!token || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Bridge origin and scoped credential are required");
  }
  async request(endpoint: string, body?: unknown, raw?: Buffer): Promise<any> {
    const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, "")}${endpoint}`, {
      method: body !== undefined || raw ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": raw ? "application/octet-stream" : "application/json" },
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Telegram bridge rejected the request (${response.status})`);
    return response.json();
  }
  async event(type: string, payload: unknown): Promise<{ eventId: number; decisionId?: number }> {
    const body = { id: randomUUID(), type, payload };
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await this.request("/v1/events", body); }
      catch (error) { last = error; }
    }
    throw last;
  }
}

export function readWorkspaceArtifact(filename: string, workspace = process.cwd()): Buffer {
  const root = realpathSync(workspace);
  const resolved = realpathSync(path.resolve(root, filename));
  const relative = path.relative(root, resolved);
  const secret = relative.split(path.sep).some(segment => /^\.env(?:\.|$)|^(?:\.ssh|\.git|\.aws|\.npmrc|\.netrc|credentials|secrets)(?:\.|$)/i.test(segment));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || secret) throw new Error("Artifact must be a non-secret file inside this workspace");
  const stat = statSync(resolved);
  if (!stat.isFile() || stat.size > 50 * 1024 * 1024) throw new Error("Artifact must be a file no larger than 50 MiB");
  return readFileSync(resolved);
}

export async function startRemoteMcp(): Promise<void> {
  const client = new RemoteBridgeClient(process.env.TELEGRAM_BRIDGE_URL ?? "", process.env.TELEGRAM_BRIDGE_TOKEN ?? "");
  const server = new McpServer({ name: "conductor-telegram", version: "0.8.0" });
  const result = (text: string) => ({ content: [{ type: "text" as const, text }] });
  server.tool("report_status", "Report progress to the Telegram operator.", {
    status: z.string().max(200), message: z.string().max(30_000),
  }, async payload => { await client.event("status", payload); return result("Status queued for Telegram."); });
  server.tool("report_artifact", "Report a PR, commit, or file to Telegram. File paths must be inside this workspace.", {
    type: z.enum(["pr", "commit", "file"]), url: z.string(), description: z.string().max(4000),
  }, async payload => {
    if (payload.type === "file") {
      const bytes = readWorkspaceArtifact(payload.url);
      const uploaded = await client.request(`/v1/attachments?name=${encodeURIComponent(path.basename(payload.url))}`, undefined, bytes);
      payload = { ...payload, url: `attachment:${uploaded.id}` };
    }
    await client.event("artifact", payload); return result("Artifact queued for Telegram.");
  });
  server.tool("refresh_attachment", "Refresh an expired download URL for an attachment belonging to this workspace.", {
    id: z.string().uuid(),
  }, async ({ id }) => result((await client.request(`/v1/attachments/${id}`, {})).url));
  server.tool("read_human_decision", "Read the answer to a previously asked question, including after a timeout or reconnect. A pending answer is never approval.", {
    id: z.number().int().positive(),
  }, async ({ id }) => {
    const decision = await client.request(`/v1/decisions/${id}`);
    return result(typeof decision.answer === "string" ? `Human responded: ${decision.answer}` : "Still pending. No approval was received.");
  });
  server.tool("list_human_decisions", "Recover this workspace's recent questions after a lost response or restart. Check context and timestamps before using an answer; it does not authorize unrelated work.", {},
    async () => result(JSON.stringify(await client.request("/v1/decisions"))));
  server.tool("request_human", "Ask the operator a question and wait for an answer. A timeout never grants approval.", {
    question: z.string().min(1).max(4000), options: z.array(z.string().max(100)).max(10).optional(),
  }, async payload => {
    const receipt = await client.event("human_request", payload);
    if (!receipt.decisionId) throw new Error("Bridge did not persist the question");
    const start = Date.now();
    while (Date.now() - start < 5 * 60_000) {
      const decision = await client.request(`/v1/decisions/${receipt.decisionId}`);
      if (typeof decision.answer === "string") return result(`Human responded: ${decision.answer}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return result(`Question ${receipt.decisionId} is still pending. No approval was received. Use read_human_decision with this ID to check again after reconnecting. Wait for the operator; do not proceed with an action that needs their answer.`);
  });
  await server.connect(new StdioServerTransport());
}
