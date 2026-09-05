import os from "node:os";
import {
  ConductorApiClient,
  conductorApiConfigFromEnv,
} from "../integrations/conductor-api.js";
import {
  applyLegacyImport,
  planLegacyImport,
  type LegacyConductorGateway,
} from "../lanes/legacy-import.js";
import { loadLaneManifest } from "../lanes/manifest.js";
import {
  LANE_HEARTBEAT_SECONDS,
  LANE_LEASE_SECONDS,
} from "../lanes/controller-policy.js";
import { createLaneStateStore } from "../lanes/state-store.js";
import { formatLaneStatus, runLaneWorker } from "../lanes/worker.js";

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function site(): "mac" | "ovh" {
  const value = process.env.LANES_SITE?.trim().toLowerCase();
  if (value === "mac" || value === "ovh") return value;
  throw new Error("LANES_SITE must be explicitly set to mac or ovh");
}

function conductorClient(): ConductorApiClient {
  const config = conductorApiConfigFromEnv({
    ...process.env,
    CONDUCTOR_CLOUD_BACKEND: "api",
  });
  if (!config) throw new Error("CONDUCTOR_API_KEY is required");
  return new ConductorApiClient(config);
}

async function status(args: string[]): Promise<void> {
  const store = await createLaneStateStore();
  try {
    const output = formatLaneStatus(await store.snapshot());
    if (args.includes("--json")) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    const controller = output.controller as Record<string, unknown> | null;
    console.log(`controller ${controller?.mode ?? "disabled"}`);
    console.log(`lease ${JSON.stringify(output.lease ?? null)}`);
    for (const [provider, capacity] of Object.entries(
      output.capacity as Record<string, { active: number; limit: number }>
    )) {
      console.log(`${provider} ${capacity.active}/${capacity.limit}`);
    }
    for (const lane of output.lanes as Array<Record<string, unknown>>) {
      console.log(
        `${lane.lane} g${lane.generation} ${lane.status}/${lane.stage}` +
          `${lane.provider ? ` ${lane.provider}` : ""}` +
          `${lane.pr ? ` ${lane.pr}` : ""}`
      );
    }
  } finally {
    await store.close();
  }
}

async function importLegacy(args: string[]): Promise<void> {
  const dryRun = args.includes("--dry-run");
  const apply = args.includes("--apply");
  if (dryRun === apply) {
    throw new Error("import-legacy requires exactly one of --dry-run or --apply");
  }
  const source =
    flagValue(args, "--source") ?? process.env.LANES_LEGACY_QUEUE?.trim();
  if (!source) throw new Error("set --source PATH or LANES_LEGACY_QUEUE");
  const manifest = loadLaneManifest();
  if (!manifest) throw new Error("Manifest v2 is missing; set LANES_MANIFEST");
  const conductor = conductorClient();
  let plan = await planLegacyImport({
    sourcePath: source,
    manifest,
    conductor: conductor as LegacyConductorGateway,
  });
  console.log(JSON.stringify(plan, null, 2));
  if (!apply) return;
  const store = await createLaneStateStore();
  const ownerSite = site();
  const lease = await store.claimLease({
    ownerId: `legacy-import:${ownerSite}:${os.hostname()}:${process.pid}`,
    ownerSite,
    leaseSeconds: 75,
  });
  if (!lease) {
    await store.close();
    throw new Error("controller lease is held; stop the worker before applying the one-time import");
  }
  let renewal: Promise<void> | null = null;
  let renewalError: unknown = null;
  const renewImportLease = () => {
    if (renewal) return;
    renewal = store
      .renewLease(
        lease,
        {
          phase: "legacy_import",
          source,
          site: ownerSite,
          pid: process.pid,
        },
        LANE_LEASE_SECONDS
      )
      .then(() => {
        renewalError = null;
      })
      .catch((error: unknown) => {
        renewalError = error;
      })
      .finally(() => {
        renewal = null;
      });
  };
  // Live legacy inventories can span more than one 75-second lease window.
  // Keep the sole import fence renewable while both authoritative discovery
  // and the internal state-only apply run; no Conductor/Git mutation occurs.
  const renewalTimer = setInterval(
    renewImportLease,
    LANE_HEARTBEAT_SECONDS * 1_000
  );
  try {
    // Re-read Conductor and Git truth after acquiring the only mutation lease.
    // The dry-run report remains useful, but a stale pre-lease snapshot is
    // never authoritative for the actual import.
    const authoritativePlan = await planLegacyImport({
      sourcePath: source,
      manifest,
      conductor: conductor as LegacyConductorGateway,
    });
    if (renewal) await renewal;
    if (renewalError) {
      throw new Error(
        `controller lease renewal failed during legacy reconciliation: ${
          renewalError instanceof Error ? renewalError.message : renewalError
        }`
      );
    }
    await store.renewLease(
      lease,
      { phase: "legacy_import_apply", source, site: ownerSite, pid: process.pid },
      LANE_LEASE_SECONDS
    );
    if (JSON.stringify(authoritativePlan) !== JSON.stringify(plan)) {
      console.log(
        JSON.stringify(
          {
            authoritative_plan_changed_after_lease: true,
            plan: authoritativePlan,
          },
          null,
          2
        )
      );
    }
    plan = authoritativePlan;
    const result = await applyLegacyImport({
      plan,
      manifest,
      store,
      lease,
    });
    console.log(JSON.stringify({ applied: true, ...result }, null, 2));
  } finally {
    clearInterval(renewalTimer);
    if (renewal) await renewal;
    await store.releaseLease(lease).catch(() => undefined);
    await store.close();
  }
}

export async function runLanes(args: string[]): Promise<void> {
  const subcommand = args[0] ?? "status";
  if (subcommand === "status") {
    await status(args.slice(1));
    return;
  }
  if (subcommand === "worker") {
    const abort = new AbortController();
    const stop = () => abort.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runLaneWorker({
        signal: abort.signal,
        once: args.includes("--once"),
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (subcommand === "reconcile") {
    await runLaneWorker({ once: true, fullReconcile: true });
    return;
  }
  if (subcommand === "import-legacy") {
    await importLegacy(args.slice(1));
    return;
  }
  throw new Error(
    `Unknown lanes subcommand ${subcommand}; expected worker, status, reconcile, or import-legacy`
  );
}
