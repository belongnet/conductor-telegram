import { Telegram } from "telegraf";
import path from "node:path";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db.js";
import { createConductorApiClientFromEnv, ConductorApiError } from "../integrations/conductor-api.js";
import { GatewayStore } from "./store.js";
import { FileBridge, startBridge } from "./bridge.js";
import { CloudEngine, DEFAULT_PROVIDERS, type Provider } from "./engine.js";
import { CloudGitHub } from "./catalog.js";
import { CloudCommands } from "./commands.js";
import { enqueueText, ingestTelegram, pause, QueueDispatcher, TelegramDelivery, type TelegramCall } from "./telegram.js";
import { CloudRouter } from "./router.js";
import { CloudPoller } from "./poller.js";
import {restoreLegacyOperations} from "./legacy.js";

export function acquireGatewayLease(store: GatewayStore, owner: string, now = Date.now()): boolean {
  return store.db.transaction(() => {
    const lease = store.get<{ owner: string; until: number }>("gateway-lease");
    if (lease && lease.owner !== owner && lease.until > now) return false;
    store.set("gateway-lease", { owner, until: now + 90_000 }); return true;
  })();
}

export async function startCloudGateway(): Promise<void> {
  const token = process.env.BOT_TOKEN;
  const ownerChatId = process.env.OWNER_CHAT_ID;
  const publicUrl = process.env.TELEGRAM_BRIDGE_PUBLIC_URL;
  if (!token || !ownerChatId || ownerChatId === "0" || !publicUrl) throw new Error("cloud-only requires BOT_TOKEN, a configured OWNER_CHAT_ID, and TELEGRAM_BRIDGE_PUBLIC_URL");
  if (ownerChatId.startsWith("-") && !process.env.OWNER_USER_ID) throw new Error("cloud-only group mode requires OWNER_USER_ID");
  const api = createConductorApiClientFromEnv({ ...process.env, CONDUCTOR_CLOUD_BACKEND: "api", CONDUCTOR_API_TIMEOUT_MS: "15000", CONDUCTOR_API_MAX_RETRIES: "0" });
  if (!api) throw new Error("Conductor API unavailable");
  const identity = await api.getIdentity();
  if (identity.workspaceId) throw new Error("cloud-only requires an organization API key, not a workspace-scoped token");
  const projects = await api.listProjects();
  if (!projects.length) throw new Error("Conductor key cannot access any projects");
  const telegram = new Telegram(token);
  const rawCall: TelegramCall = (method, payload) => (telegram.callApi as any)(method, payload, {
    signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : method === "sendDocument" ? 60_000 : 10_000),
  });
  const me = await rawCall("getMe", {});
  const webhook = await rawCall("getWebhookInfo", {});
  if (webhook.url) throw new Error("A Telegram webhook is active; remove it during the controlled cutover before starting this poller");
  const db = getDb();
  if (db.name !== ":memory:") chmodSync(db.name, 0o600);
  const store = new GatewayStore(db);
  const recordedBot = store.get<number>("telegram-bot-id");
  if (recordedBot && recordedBot !== me.id) throw new Error("This database belongs to a different Telegram bot. Use isolated state for a test bot.");
  const recordedOrganization = store.get<string>("conductor-organization-id");
  if (recordedOrganization && identity.organizationId && recordedOrganization !== identity.organizationId) throw new Error("Conductor organization differs from this gateway's persisted identity");
  const abort = new AbortController();
  const owner = randomUUID();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  while (!abort.signal.aborted && !acquireGatewayLease(store, owner)) await pause(1000, abort.signal);
  if (abort.signal.aborted) return;
  store.recover();
  store.set("conductor-user-id", identity.userId);
  store.set("telegram-bot-id", me.id);
  store.set("telegram-bot-username", me.username);
  if (identity.organizationId) store.set("conductor-organization-id", identity.organizationId);
  store.set("projects", { at: Date.now(), projects });
  const checkLease = (): void => {
    const lease = store.get<{ owner: string; until: number }>("gateway-lease");
    if (lease?.owner !== owner || lease.until <= Date.now() || abort.signal.aborted) throw new Error("Gateway lease lost");
  };
  store.assertWriter = checkLease;
  const call: TelegramCall = async (method, payload) => { checkLease(); const result = await rawCall(method, payload); checkLease(); return result; };
  const fencedApi = new Proxy(api, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        checkLease();
        const remaining = (store.get<number>("cloud-api-not-before") ?? 0) - Date.now();
        if (remaining > 0) throw new ConductorApiError("Conductor API cooldown", 429, true, remaining);
        try { const result = await value.apply(target, args); checkLease(); return result; }
        catch (error) {
          if (error instanceof ConductorApiError && error.retryAfterMs > 0) store.set("cloud-api-not-before", Date.now() + error.retryAfterMs);
          throw error;
        }
      };
    },
  });
  const bridge = new FileBridge(store, publicUrl, process.env.TELEGRAM_BRIDGE_FILES_DIR ?? path.join(path.dirname(db.name), "attachments"));
  const github = new CloudGitHub(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "");
  const primaryAgent = process.env.TELEGRAM_DEFAULT_AGENT_TYPE;
  const configured = DEFAULT_PROVIDERS.find(p => p.agent === primaryAgent);
  if (primaryAgent && !configured) throw new Error("Unsupported configured cloud provider");
  const primary: Provider = { ...(configured ?? DEFAULT_PROVIDERS[0]), model: process.env.TELEGRAM_DEFAULT_MODEL ?? (configured ?? DEFAULT_PROVIDERS[0]).model };
  const enabled = (process.env.TELEGRAM_CLOUD_PROVIDERS ?? "claude,codex,cursor").split(",").map(p => p.trim());
  if (!enabled.includes(primary.agent) || enabled.some(p => !DEFAULT_PROVIDERS.some(d => d.agent === p))) throw new Error("TELEGRAM_CLOUD_PROVIDERS must include the configured primary and only supported providers");
  const reviewAgent = process.env.TELEGRAM_REVIEW_AGENT_TYPE;
  if (reviewAgent && !enabled.includes(reviewAgent)) throw new Error("TELEGRAM_REVIEW_AGENT_TYPE must name an enabled cloud provider");
  const engine = new CloudEngine(store, fencedApi, bridge, github, [primary, ...DEFAULT_PROVIDERS.filter(p => p.agent !== primary.agent && enabled.includes(p.agent))], process.env.TELEGRAM_CLOUD_REVIEW_POLICY === "native",
    {agent: reviewAgent as Provider["agent"] | undefined, model: process.env.TELEGRAM_REVIEW_MODEL});
  restoreLegacyOperations(engine);
  const commands = new CloudCommands(store, engine, call, ownerChatId, process.env.OWNER_USER_ID);
  const delivery = new TelegramDelivery(store, call);
  const router = new CloudRouter(engine, process.env.TELEGRAM_CLOUD_ROUTER_PROJECT_ID);
  const poller = new CloudPoller(engine);
  const dispatchers = {
    updates: new QueueDispatcher(store, ["update"], row => commands.handle(row)),
    health: new QueueDispatcher(store, ["health-update"], row => commands.handle(row), 1),
    actions: new QueueDispatcher(store, ["cloud"], row => engine.action(row)),
    media: new QueueDispatcher(store, ["media"], row => commands.media(row), 1),
    router: new QueueDispatcher(store, ["route"], row => router.route(row), 1),
  };
  const server = startBridge(bridge, Number(process.env.TELEGRAM_BRIDGE_PORT ?? "8787"), process.env.TELEGRAM_BRIDGE_HOST ?? "127.0.0.1");
  server.on("error", () => abort.abort());

  const loop = async (name: string, ms: number, fn: () => Promise<void> | void) => {
    while (!abort.signal.aborted) {
      try { checkLease(); await fn(); }
      catch (error) {
        store.set(`loop-error:${name}`, { at: Date.now(), message: error instanceof Error ? error.message.replace(/bot\d+:[\w-]+/g, "bot[redacted]") : "Loop failed" });
        console.error(`[${name}] operation failed; details are in the private gateway state`);
      }
      await pause(ms, abort.signal);
    }
  };
  const reportBlocked = () => {
    const rows = db.prepare("SELECT id,kind,conversation,error,payload FROM gateway_queue WHERE state='blocked' AND kind!='telegram'").all() as any[];
    for (const row of rows) {
      if (store.get(`blocked-notified:${row.id}`)) continue;
      const payload = JSON.parse(row.payload);
      const trackedId = payload.trackedId ?? payload.action?.trackedId;
      if (trackedId) engine.notify(`blocked:${row.id}`, trackedId, `Operation needs attention: ${row.error}`);
      else enqueueText(store, `blocked:${row.id}`, ownerChatId, `Telegram operation needs attention: ${row.error}`);
      store.set(`blocked-notified:${row.id}`, true);
    }
  };
  try {
    await Promise.all([
      ingestTelegram(store, call, abort.signal).catch(error => { abort.abort(); throw error; }),
      loop("lease", 10_000, () => { if (!acquireGatewayLease(store, owner)) { abort.abort(); throw new Error("Gateway lease lost"); } }),
      loop("updates", 100, () => dispatchers.updates.tick()),
      loop("health-commands", 100, () => dispatchers.health.tick()),
      loop("cloud-actions", 250, () => dispatchers.actions.tick()),
      loop("media", 500, () => dispatchers.media.tick()),
      loop("router", 1000, () => dispatchers.router.tick()),
      loop("delivery", 100, () => delivery.tick()),
      loop("events", 1000, () => { engine.events(); reportBlocked(); }),
      loop("cloud-poller", 1000, () => poller.tick()),
      loop("cloud-access", 60_000, async () => { await fencedApi.getIdentity(); store.set("cloud-access-last-success", Date.now()); }),
      loop("retention", 3600_000, () => bridge.prune()),
    ]);
  } finally {
    abort.abort(); server.close();
    await Promise.all([poller.settled(), ...Object.values(dispatchers).map(worker => worker.settled())]);
    // Leave the lease to expire: outstanding upstream calls can still be settling.
  }
}
