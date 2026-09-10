import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, unlinkSync, lstatSync, createReadStream } from "node:fs";
import path from "node:path";
import type { GatewayStore } from "./store.js";
import { addEvent, createDecision, getDecision, getWorkspace } from "../store/queries.js";
import { z } from "zod";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const LINK_TTL_MS = 15 * 60_000;
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");
const EventSchema = z.object({
  id: z.string().uuid(), type: z.enum(["status", "artifact", "human_request"]),
  payload: z.union([
    z.object({ status: z.string().max(200), message: z.string().max(30_000) }).strict(),
    z.object({ type: z.enum(["pr", "commit", "file"]), url: z.string().max(2048), description: z.string().max(4000) }).strict(),
    z.object({ question: z.string().min(1).max(4000), options: z.array(z.string().max(100)).max(10).optional() }).strict(),
  ]),
}).strict().superRefine((event, ctx) => {
  if ((event.type === "status" && !("status" in event.payload)) ||
      (event.type === "artifact" && !("type" in event.payload)) ||
      (event.type === "human_request" && !("question" in event.payload))) {
    ctx.addIssue({ code: "custom", message: "Event payload does not match its type" });
  }
});

interface FileRow { id: string; workspace_id: string; name: string; path: string; size: number; token_hash: string | null; expires_at: number | null; created_at: number }

export class FileBridge {
  readonly directory: string;
  constructor(readonly store: GatewayStore, readonly publicUrl: string, directory: string) {
    const origin = new URL(publicUrl);
    if (origin.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw new Error("Bridge public URL must use HTTPS");
    if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw new Error("Bridge must be an HTTPS origin without a path");
    this.directory = path.resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error("Bridge file directory cannot be a symlink");
  }

  issueCredential(workspaceId: string): string {
    this.store.assertWriter?.();
    if (!getWorkspace(workspaceId)) throw new Error("Unknown tracked workspace");
    const token = randomBytes(32).toString("base64url");
    this.store.db.prepare("INSERT INTO gateway_credentials(token_hash,workspace_id) VALUES(?,?)").run(tokenHash(token), workspaceId);
    return token;
  }

  authorize(token: string): string | null {
    if (!token) return null;
    const row = this.store.db.prepare("SELECT workspace_id FROM gateway_credentials WHERE token_hash=? AND revoked=0").get(tokenHash(token)) as any;
    if (!row || !getWorkspace(row.workspace_id) || getWorkspace(row.workspace_id)?.archivedAt) return null;
    return row.workspace_id;
  }

  save(workspaceId: string, name: string, bytes: Buffer): string {
    this.store.assertWriter?.();
    if (!getWorkspace(workspaceId)) throw new Error("Unknown tracked workspace");
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw new Error("Attachment must contain 1 byte to 50 MiB");
    const id = randomUUID();
    const filename = path.basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "_").slice(0, 180) || "attachment";
    const localPath = path.join(this.directory, id);
    writeFileSync(localPath, bytes, { flag: "wx", mode: 0o600 });
    try {
      this.store.db.prepare("INSERT INTO gateway_files(id,workspace_id,name,path,size,created_at) VALUES(?,?,?,?,?,?)")
        .run(id, workspaceId, filename, localPath, bytes.length, Date.now());
    } catch (error) { unlinkSync(localPath); throw error; }
    return id;
  }

  file(id: string, workspaceId?: string): FileRow | undefined {
    const row = this.store.db.prepare("SELECT * FROM gateway_files WHERE id=?").get(id) as FileRow | undefined;
    if (!row || (workspaceId && row.workspace_id !== workspaceId)) return undefined;
    if (path.dirname(row.path) !== this.directory || path.basename(row.path) !== row.id || lstatSync(row.path).isSymbolicLink()) throw new Error("Invalid attachment storage path");
    return row;
  }

  link(id: string, workspaceId: string): string {
    this.store.assertWriter?.();
    if (!this.file(id, workspaceId)) throw new Error("Attachment not found");
    const token = randomBytes(32).toString("base64url");
    this.store.db.prepare("UPDATE gateway_files SET token_hash=?,expires_at=? WHERE id=?").run(tokenHash(token), Date.now() + LINK_TTL_MS, id);
    this.store.db.prepare("INSERT INTO gateway_file_links VALUES(?,?,?)").run(tokenHash(token), id, Date.now() + LINK_TTL_MS);
    return `${this.publicUrl.replace(/\/$/, "")}/v1/attachments/${id}?token=${token}`;
  }

  validLink(id: string, token: string, now = Date.now()): FileRow | undefined {
    const file = this.file(id);
    const link = this.store.db.prepare("SELECT 1 FROM gateway_file_links WHERE token_hash=? AND file_id=? AND expires_at>?").get(tokenHash(token), id, now);
    return link && file ? file : undefined;
  }

  refreshQueuedLinks(message: string, workspaceId: string): void {
    this.store.assertWriter?.();
    for (const candidate of message.match(/https?:\/\/[^\s]+/g) ?? []) {
      let url: URL; try { url = new URL(candidate); } catch { continue; }
      if (url.origin !== new URL(this.publicUrl).origin) continue;
      const id = url.pathname.match(/\/v1\/attachments\/([\w-]+)$/)?.[1];
      const token = url.searchParams.get("token");
      if (id && token && this.file(id, workspaceId)) this.store.db.prepare("UPDATE gateway_file_links SET expires_at=? WHERE file_id=? AND token_hash=?")
        .run(Date.now() + LINK_TTL_MS, id, tokenHash(token));
    }
  }

  prune(now = Date.now()): void {
    // Retain attachments and link identities for history and queued work. Expiry is
    // checked at download time; deleting bytes here would lose migrated history.
    this.store.assertWriter?.();
  }

  event(workspaceId: string, input: unknown): { eventId: number; decisionId?: number } {
    this.store.assertWriter?.();
    const event = EventSchema.parse(input);
    return this.store.db.transaction(() => {
      const key = `bridge-event:${workspaceId}:${event.id}`;
      const existing = this.store.get<{ eventId: number; decisionId?: number; body: string }>(key);
      const body = JSON.stringify(event);
      if (existing) {
        if (existing.body !== body) throw new Error("Event identity reused with different content");
        return { eventId: existing.eventId, decisionId: existing.decisionId };
      }
      if (event.type === "artifact" && "type" in event.payload && event.payload.type === "file") {
        const id = event.payload.url.replace(/^attachment:/, "");
        if (!this.file(id, workspaceId)) throw new Error("File artifact must be uploaded to this workspace first");
        event.payload.url = `attachment:${id}`;
      }
      const decisionId = "question" in event.payload ? createDecision(workspaceId, event.payload.question, event.payload.options ?? null) : undefined;
      const eventId = addEvent(workspaceId, event.type, JSON.stringify({ ...event.payload, ...(decisionId ? { decisionId } : {}) }));
      const result = { eventId, ...(decisionId ? { decisionId } : {}) };
      this.store.set(key, { ...result, body });
      return result;
    })();
  }
}

export function gatewayHealth(store: GatewayStore, now = Date.now()): { ready: boolean; checks: Record<string, unknown> } {
  const ingress = now - (store.get<number>("ingestion-last-success") ?? 0);
  const poll = now - (store.get<number>("cloud-access-last-success") ?? store.get<number>("cloud-poll-last-success") ?? 0);
  const stalledWorkspaces = store.bindings().filter(({id}) => {
    const error = store.get<number>(`poll-error:${id}`) ?? 0;
    const success = store.get<number>(`poll-success:${id}`) ?? 0;
    return error > success && now - success > 120_000;
  }).length;
  const delivery = store.backlog();
  const recent = store.db.prepare("SELECT id,completed_at-created_at AS latency FROM gateway_queue WHERE kind='telegram' AND state='done' AND completed_at>? AND (id LIKE 'update:%:reply:%' OR id LIKE 'transcript:%') ORDER BY latency")
    .all(now - 24 * 3600_000) as Array<{id: string; latency: number}>;
  const latency = (prefix: string) => { const values = recent.filter(row => row.id.startsWith(prefix)).map(row => row.latency); return {samples: values.length, p95QueueMs: values.length ? values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] : null}; };
  const syncEnabled = store.get("cloud-sync-enabled");
  const syncStatus = store.get<{at: number; failures: number}>("cloud-sync-status");
  const syncHealthy = !syncEnabled || (!!syncStatus && syncStatus.failures === 0 && now - syncStatus.at < 180_000);
  const ready = ingress < 90_000 && poll < 120_000 && !stalledWorkspaces && delivery.blocked === 0 && delivery.oldestMs < 300_000 && syncHealthy;
  return { ready, checks: { ingestionAgeMs: ingress, cloudPollAgeMs: poll, delivery,
    ...(syncEnabled ? {workspaceSync: syncStatus ?? {pending: true}} : {}),
    stalledWorkspaces, acknowledgements: latency("update:"), transcriptDelivery: latency("transcript:") } };
}

export function startBridge(bridge: FileBridge, port: number, host = "127.0.0.1") {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://bridge");
      if (req.method === "GET" && url.pathname === "/health/live") return json(res, 200, { live: true });
      if (req.method === "GET" && url.pathname === "/health/ready") {
        const health = gatewayHealth(bridge.store); return json(res, health.ready ? 200 : 503, health);
      }
      const fileMatch = url.pathname.match(/^\/v1\/attachments\/([\w-]+)$/);
      if (req.method === "GET" && fileMatch && url.searchParams.has("token")) {
        const file = bridge.validLink(fileMatch[1], url.searchParams.get("token")!);
        if (!file) return json(res, 404, { error: "Attachment unavailable" });
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.size,
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        const stream = createReadStream(file.path); stream.on("error", () => res.destroy()); stream.pipe(res); return;
      }
      const workspaceId = bridge.authorize(req.headers.authorization?.replace(/^Bearer /, "") ?? "");
      if (!workspaceId) return json(res, 401, { error: "Unauthorized" });
      if (req.method === "GET" && ["/v1/client", "/v1/bootstrap"].includes(url.pathname)) {
        const filename = url.pathname === "/v1/client" ? process.env.TELEGRAM_BRIDGE_CLIENT_PACKAGE : process.env.TELEGRAM_BRIDGE_BOOTSTRAP;
        if (!filename) return json(res, 503, {error: "Cloud client release unavailable"});
        res.writeHead(200, {"Content-Type": "application/octet-stream", "Cache-Control": "no-store"});
        const stream = createReadStream(filename); stream.on("error", () => res.destroy()); stream.pipe(res); return;
      }
      if (req.method === "POST" && url.pathname === "/v1/attachments") {
        const bytes = await readBody(req, MAX_FILE_BYTES);
        return json(res, 201, { id: bridge.save(workspaceId, url.searchParams.get("name") ?? "artifact", bytes) });
      }
      if (req.method === "POST" && fileMatch) return json(res, 200, { url: bridge.link(fileMatch[1], workspaceId) });
      if (req.method === "POST" && url.pathname === "/v1/events") {
        return json(res, 200, bridge.event(workspaceId, JSON.parse((await readBody(req, 128 * 1024)).toString("utf8"))));
      }
      const decisionMatch = url.pathname.match(/^\/v1\/decisions\/(\d+)$/);
      if (req.method === "GET" && url.pathname === "/v1/decisions") {
        const decisions = bridge.store.db.prepare("SELECT id,question,options,answer,created_at,answered_at FROM decisions WHERE workspace_id=? ORDER BY id DESC LIMIT 20").all(workspaceId);
        return json(res, 200, {decisions});
      }
      if (req.method === "GET" && decisionMatch) {
        const decision = getDecision(Number(decisionMatch[1]));
        if (decision?.workspaceId !== workspaceId) return json(res, 404, { error: "Decision not found" });
        return json(res, 200, { answer: decision.answer });
      }
      return json(res, 404, { error: "Not found" });
    } catch (error) {
      // Do not reflect request URLs, scoped credentials, or server file paths.
      return json(res, error instanceof BodyTooLarge ? 413 : 400, { error: "Request rejected" });
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.listen(port, host);
  return server;
}

class BodyTooLarge extends Error {}
async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw new BodyTooLarge();
    parts.push(part);
  }
  return Buffer.concat(parts);
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value));
}
