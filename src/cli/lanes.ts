import os from "node:os";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import path from "node:path";
import {
  ConductorApiClient,
  conductorApiConfigFromEnv,
} from "../integrations/conductor-api.js";
import {
  applyLegacyImport,
  planLegacyImport,
  type LegacyConductorGateway,
} from "../lanes/legacy-import.js";
import { canonicalManifestJson, loadLaneManifest } from "../lanes/manifest.js";
import {
  LANE_HEARTBEAT_SECONDS,
  LANE_LEASE_SECONDS,
  deterministicLaneId,
} from "../lanes/controller-policy.js";
import {
  createLaneStateStore,
  retirementEvidenceProvesCompletion,
} from "../lanes/state-store.js";
import { formatLaneStatus, runLaneWorker } from "../lanes/worker.js";

function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

export const MAX_RETIREMENT_EVIDENCE_BYTES = 1024 * 1024;

export function readRetirementEvidenceFile(filename: string): unknown {
  const resolved = path.resolve(filename);
  const initial = lstatSync(resolved);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new Error("retirement evidence path must be a regular non-symlink file");
  }
  if (initial.size > MAX_RETIREMENT_EVIDENCE_BYTES) {
    throw new Error("retirement evidence file exceeds the 1 MiB limit");
  }
  const descriptor = openSync(
    resolved,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== initial.dev ||
      opened.ino !== initial.ino
    ) {
      throw new Error("retirement evidence file changed during secure open");
    }
    const buffer = Buffer.alloc(MAX_RETIREMENT_EVIDENCE_BYTES + 1);
    const bytes = readSync(
      descriptor,
      buffer,
      0,
      buffer.length,
      0
    );
    if (bytes > MAX_RETIREMENT_EVIDENCE_BYTES) {
      throw new Error("retirement evidence file exceeds the 1 MiB limit");
    }
    return JSON.parse(buffer.subarray(0, bytes).toString("utf8"));
  } finally {
    closeSync(descriptor);
  }
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

async function queueLaneControl(
  command: "hold" | "release" | "retire" | "validate",
  args: string[]
): Promise<void> {
  const laneId = args[0]?.trim();
  if (!laneId) throw new Error(`lanes ${command} requires a lane id`);
  const store = await createLaneStateStore();
  try {
    const snapshot = await store.snapshot();
    const revision = snapshot.controller?.active_revision_id;
    if (!revision || snapshot.manifest?.revision_id !== revision) {
      throw new Error("lane control requires the exact active manifest revision");
    }
    if (
      !((snapshot.manifest.manifest_json.lanes as Array<{ id?: string }> | undefined) ?? []).some(
        (lane) => lane.id === laneId
      )
    ) {
      throw new Error(`lane ${laneId} is absent from active manifest ${revision}`);
    }
    const kind = `lane_${command}`;
    const scoped = snapshot.lane_controls.find(
      (control) =>
        control.manifest_revision_id === revision && control.lane_id === laneId
    );
    const payload: Record<string, unknown> = {
      manifest_revision_id: revision,
    };
    if (command === "hold") {
      const reason = flagValue(args, "--reason")?.trim();
      if (!reason) throw new Error("lanes hold requires --reason TEXT");
      payload.reason = reason;
    }
    if (command === "release" || command === "validate") {
      if (scoped?.state !== "held" || !scoped.control_id) {
        throw new Error(`lanes ${command} requires the current durable lane hold`);
      }
      payload.expected_hold_control_id = scoped.control_id;
      if (command === "validate") {
        if (!scoped.run_id || !scoped.merged_sha) {
          throw new Error("lanes validate requires a held merged validation run");
        }
        payload.expected_run_id = scoped.run_id;
        payload.merged_sha = scoped.merged_sha;
      }
    }
    if (command === "retire") {
      const mergedSha = flagValue(args, "--merged-sha")?.trim().toLowerCase();
      const evidencePath = flagValue(args, "--evidence-json")?.trim();
      if (!mergedSha || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(mergedSha)) {
        throw new Error("lanes retire requires --merged-sha with a full Git SHA");
      }
      if (!evidencePath) {
        throw new Error("lanes retire requires --evidence-json PATH");
      }
      let evidenceRefs: unknown;
      try {
        evidenceRefs = readRetirementEvidenceFile(evidencePath);
      } catch (error) {
        throw new Error(
          `could not read retirement evidence JSON: ${
            error instanceof Error ? error.message : error
          }`
        );
      }
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        throw new Error("retirement evidence JSON must be a non-empty array");
      }
      if (!retirementEvidenceProvesCompletion(evidenceRefs)) {
        throw new Error(
          "retirement evidence requires a successful merge record and validation receipt"
        );
      }
      const run = snapshot.runs
        .filter(
          (candidate) =>
            candidate.manifest_revision_id === revision &&
            candidate.lane_id === laneId
        )
        .sort((left, right) => right.generation - left.generation)[0];
      if (!run || run.merged_sha !== mergedSha) {
        throw new Error(
          "retirement SHA must match the latest active-revision lane run"
        );
      }
      for (const [index, ref] of evidenceRefs.entries()) {
        const document =
          ref && typeof ref === "object"
            ? (ref as Record<string, unknown>).evidence_document
            : null;
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw new Error(`retirement evidence ${index} lacks evidence_document`);
        }
        const identity = document as Record<string, unknown>;
        if (
          identity.manifest_revision_id !== revision ||
          identity.lane_id !== laneId ||
          identity.run_id !== run.run_id ||
          identity.merged_sha !== mergedSha
        ) {
          throw new Error(
            `retirement evidence ${index} does not match the active revision/lane/run/SHA`
          );
        }
      }
      payload.merged_sha = mergedSha;
      payload.evidence_refs = evidenceRefs;
    }
    const idempotencyKey = deterministicLaneId(
      "operator-control",
      kind,
      revision,
      laneId,
      scoped?.control_id ?? "none",
      canonicalManifestJson(payload)
    );
    const human = ["release", "retire", "validate"].includes(command);
    const created = await store.createControl({
      control_id: idempotencyKey,
      idempotency_key: idempotencyKey,
      kind,
      lane_id: laneId,
      requested_by: `cli:${os.hostname()}`,
      payload,
      approvalKey: human
        ? process.env.BELONG_HUMAN_APPROVAL_KEY?.trim()
        : undefined,
    });
    console.log(JSON.stringify(created, null, 2));
  } finally {
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
  if (
    subcommand === "hold" ||
    subcommand === "release" ||
    subcommand === "retire" ||
    subcommand === "validate"
  ) {
    await queueLaneControl(subcommand, args.slice(1));
    return;
  }
  throw new Error(
    `Unknown lanes subcommand ${subcommand}; expected worker, status, reconcile, import-legacy, hold, release, retire, or validate`
  );
}
