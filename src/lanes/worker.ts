import { createHash } from "node:crypto";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  ConductorApiClient,
  conductorApiConfigFromEnv,
} from "../integrations/conductor-api.js";
import { gitlabLaneGatewayFromEnv } from "../bot/gitlab.js";
import {
  LANE_ACTIVE_POLL_SECONDS,
  LANE_FULL_RECONCILE_SECONDS,
  LANE_HEARTBEAT_SECONDS,
  LANE_IDLE_POLL_SECONDS,
  LANE_LEASE_SECONDS,
  LANE_STANDBY_POLL_SECONDS,
} from "./controller-policy.js";
import { asConductorLaneGateway, LaneController } from "./controller.js";
import {
  laneManifestRevisionId,
  loadLaneManifest,
  type LaneManifestV2,
} from "./manifest.js";
import {
  createLaneStateStore,
  LaneStateStoreError,
  type LaneLease,
  type LaneSnapshotV2,
  type LaneStateStore,
} from "./state-store.js";

export type WorkerSite = "mac" | "ovh";

export type LaneWorkerOptions = {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  once?: boolean;
  fullReconcile?: boolean;
  log?: (line: string) => void;
};

export function missingLaneWorkerAlertConfig(
  env: NodeJS.ProcessEnv
): string[] {
  return ["BOT_TOKEN", "OWNER_CHAT_ID"].filter(
    (name) => !env[name]?.trim()
  );
}

function parseSite(env: NodeJS.ProcessEnv): WorkerSite {
  const value = env.LANES_SITE?.trim().toLowerCase();
  if (value === "mac" || value === "ovh") return value;
  throw new Error("LANES_SITE must be explicitly set to mac or ovh");
}

function requiredConductorClient(env: NodeJS.ProcessEnv): ConductorApiClient {
  const configuredTimeout = Number(env.CONDUCTOR_API_TIMEOUT_MS?.trim() || 30_000);
  if (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0 || configuredTimeout > 30_000) {
    throw new Error(
      "lanes worker requires CONDUCTOR_API_TIMEOUT_MS between 1 and 30000 so mutations settle before lease failover"
    );
  }
  const config = conductorApiConfigFromEnv({
    ...env,
    CONDUCTOR_CLOUD_BACKEND: "api",
  });
  if (!config) throw new Error("Conductor API configuration is required");
  // The general API client retries safe/idempotent requests. Lane mutations
  // instead reconcile their durable action intent after any lost response;
  // inline retries could outlive the 75-second controller fence.
  return new ConductorApiClient({ ...config, maxRetries: 0 });
}

export function formatLaneStatus(snapshot: LaneSnapshotV2): Record<string, unknown> {
  const now = Date.now();
  const pendingArchiveApprovals = snapshot.runs
    .filter((run) => {
      if (!run.workspace_id || run.legacy_verified) return false;
      const name = String(run.workspace_name ?? "");
      const managed = [
        "[managed:growth]",
        `[lane:${run.lane_id}]`,
        `[run:${run.run_id}]`,
      ].every((tag) => name.includes(tag));
      const approvedUntil = Date.parse(
        String(run.metadata_json.archive_approved_until ?? "")
      );
      const exactApproval =
        run.metadata_json.archive_approved_workspace_id === run.workspace_id &&
        Number.isFinite(approvedUntil) &&
        approvedUntil > now;
      return !managed && !exactApproval;
    })
    .map((run) => ({ lane: run.lane_id, workspace: run.workspace_id }));
  return {
    controller: snapshot.controller,
    lease: snapshot.lease,
    capacity: snapshot.capacity,
    provider_breakers: snapshot.providers,
    lanes: snapshot.runs.map((run) => {
      const attempt = snapshot.attempts
        .filter((candidate) => candidate.run_id === run.run_id)
        .sort((left, right) => right.attempt_number - left.attempt_number)[0];
      return {
        lane: run.lane_id,
        generation: run.generation,
        status: run.status,
        stage: run.stage,
        provider: run.provider,
        workspace: run.workspace_id,
        session: run.session_id,
        attempt: attempt
          ? {
              number: attempt.attempt_number,
              role: attempt.role,
              stage: attempt.stage,
              status: attempt.status,
              provider: attempt.provider,
              workspace: attempt.workspace_id,
              session: attempt.session_id,
            }
          : null,
        pr: run.pr_url,
        head: run.head_sha,
        merged: run.merged_sha,
        retry_at: run.retry_at,
        ambiguous_action: run.ambiguous_action_id,
      };
    }),
    ambiguous_actions: snapshot.ambiguous_actions,
    duplicates: snapshot.duplicates,
    pending_approvals: [
      ...snapshot.pending_controls.filter((control) => control.human_approved),
      ...pendingArchiveApprovals,
    ],
  };
}

class TelegramLaneNotifier {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly store: LaneStateStore,
    private readonly lease: () => LaneLease | null
  ) {}

  async send(message: string, key: string): Promise<void> {
    const token = this.env.BOT_TOKEN?.trim();
    const chatId = this.env.OWNER_CHAT_ID?.trim();
    if (!token || !chatId) return;
    const lease = this.lease();
    if (!lease) return;
    const snapshot = await this.store.snapshot();
    if (!snapshot.controller) return;
    const claim = await this.store.claimNotification(lease, {
      notification_key: key,
      message_hash: createHash("sha256").update(message).digest("hex"),
      expected_controller_version: snapshot.controller.row_version,
    });
    if (!claim.claimed) return;
    const response = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) throw new Error(`Telegram lane alert failed: HTTP ${response.status}`);
  }

  async daily(snapshot: LaneSnapshotV2): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const terminal = snapshot.runs.filter((run) => run.status === "validated").length;
    const active = snapshot.runs.filter(
      (run) => !["validated", "failed", "cancelled", "superseded"].includes(run.status)
    ).length;
    const caps = Object.entries(snapshot.capacity)
      .map(([provider, value]) => `${provider} ${value.active}/${value.limit}`)
      .join(", ");
    await this.send(
      `Growth lanes daily: ${active} active, ${terminal} validated; ${caps}; ` +
        `${snapshot.ambiguous_actions.length} ambiguous, ${snapshot.duplicates.length} duplicate bindings.`,
      `daily:${day}`
    );
  }
}

async function stageManifest(
  store: LaneStateStore,
  lease: LaneLease,
  manifest: LaneManifestV2,
  ownerId: string,
  env: NodeJS.ProcessEnv
): Promise<{ revisionId: string; rowVersion: number }> {
  const revision = laneManifestRevisionId(manifest);
  const staged = await store.stageManifest(lease, {
    revisionId: revision,
    sourceRef:
      env.LANES_MANIFEST_SOURCE_REF?.trim() ||
      `sha256:${manifest.manifestHash}`,
    manifest,
    createdBy: ownerId,
  });
  const rowVersion = Number(staged.row_version);
  if (!Number.isInteger(rowVersion) || rowVersion < 1) {
    throw new Error("staged manifest response omitted its row version");
  }
  return { revisionId: revision, rowVersion };
}

export async function runLaneWorker(options: LaneWorkerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const site = parseSite(env);
  const missingAlerts = missingLaneWorkerAlertConfig(env);
  if (missingAlerts.length > 0) {
    throw new Error(
      `lanes worker requires ${missingAlerts.join(
        ", "
      )} so either lease holder can deliver safety alerts; the OVH service remains headless and never polls Telegram`
    );
  }
  const manifest = loadLaneManifest(env);
  if (!manifest) throw new Error("Manifest v2 is missing; set LANES_MANIFEST");
  const store = await createLaneStateStore(env);
  const conductor = requiredConductorClient(env);
  const gitlab = manifest.lanes.some(
    (lane) => lane.delivery_adapter.kind === "gitlab"
  )
    ? gitlabLaneGatewayFromEnv(env)
    : undefined;
  let lease: LaneLease | null = null;
  const notifier = new TelegramLaneNotifier(env, store, () => lease);
  const ownerId = `${site}:${os.hostname()}:${process.pid}`;
  const controller = new LaneController({
    store,
    conductor: asConductorLaneGateway(conductor),
    gitlab,
    notify: async (message, key) => {
      try {
        await notifier.send(message, key);
      } catch (error) {
        log(`lane alert warning: ${error instanceof Error ? error.message : error}`);
      }
    },
  });
  let leaseLost = false;
  let heartbeatRunning = false;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let lastFullReconcile = 0;
  let loggedRevision: string | null = null;
  let lastTickReason: string | null = null;

  const stopHeartbeat = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
  const heartbeat = async () => {
    if (!lease || heartbeatRunning || leaseLost) return;
    heartbeatRunning = true;
    try {
      const snapshot = await store.snapshot();
      lease = await store.renewLease(
        lease,
        {
          site,
          pid: process.pid,
          mode: snapshot.controller?.mode ?? "disabled",
          active_runs: snapshot.runs.filter(
            (run) => !["validated", "failed", "cancelled", "superseded"].includes(run.status)
          ).length,
          capacity: snapshot.capacity,
          revision: snapshot.controller?.active_revision_id ?? null,
          last_tick_reason: lastTickReason,
        },
        LANE_LEASE_SECONDS
      );
    } catch (error) {
      leaseLost = true;
      log(`lane lease lost: ${error instanceof Error ? error.message : error}`);
    } finally {
      heartbeatRunning = false;
    }
  };

  try {
    while (!options.signal?.aborted) {
      if (!lease || leaseLost) {
        stopHeartbeat();
        lease = await store.claimLease({
          ownerId,
          ownerSite: site,
          leaseSeconds: LANE_LEASE_SECONDS,
        });
        leaseLost = false;
        if (!lease) {
          if (options.once) return;
          await delay(LANE_STANDBY_POLL_SECONDS * 1000, undefined, {
            signal: options.signal,
          }).catch(() => undefined);
          continue;
        }
        log(`lane lease claimed site=${site} fence=${lease.fence}`);
        heartbeatTimer = setInterval(
          () => void heartbeat(),
          LANE_HEARTBEAT_SECONDS * 1000
        );
      }
      const staged = await stageManifest(store, lease, manifest, ownerId, env);
      const revision = staged.revisionId;
      if (loggedRevision !== revision) {
        log(`lane manifest staged revision=${revision} hash=${manifest.manifestHash}`);
        loggedRevision = revision;
      }
      let snapshot = await store.snapshot();
      // Recover a crash between activation and resolving the human cutover
      // control. No external action can run until the controller row is active.
      if (
        snapshot.controller?.active_revision_id === revision &&
        snapshot.manifest?.revision_id !== revision
      ) {
        await store.activateManifest(lease, revision, staged.rowVersion);
        snapshot = await store.snapshot();
      }
      const now = Date.now();
      const fullReconcile =
        options.fullReconcile === true ||
        now - lastFullReconcile >= LANE_FULL_RECONCILE_SECONDS * 1000;
      const result = await controller.tick({
        lease,
        manifest,
        fullReconcile,
        expectedRevisionId: revision,
        expectedManifestVersion: staged.rowVersion,
      });
      lastTickReason = result.reason.slice(0, 1_000);
      if (fullReconcile && result.fullReconcileComplete === true) {
        lastFullReconcile = now;
      }
      snapshot = await store.snapshot();
      try {
        await notifier.daily(snapshot);
      } catch (error) {
        log(`lane daily-summary warning: ${error instanceof Error ? error.message : error}`);
      }
      log(
        `lane tick acted=${result.acted} active=${result.active} ` +
          `reason=${JSON.stringify(result.reason)}${result.runId ? ` run=${result.runId}` : ""}`
      );
      if (options.once) return;
      await delay(
        (result.active ? LANE_ACTIVE_POLL_SECONDS : LANE_IDLE_POLL_SECONDS) * 1000,
        undefined,
        { signal: options.signal }
      ).catch(() => undefined);
    }
  } finally {
    stopHeartbeat();
    if (lease && !leaseLost) {
      try {
        await store.releaseLease(lease);
      } catch (error) {
        if (!(error instanceof LaneStateStoreError && error.conflict)) {
          log(`lane lease release warning: ${error instanceof Error ? error.message : error}`);
        }
      }
    }
    await store.close();
  }
}
