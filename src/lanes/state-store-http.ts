import type {
  BeginActionInput,
  BeginAttemptInput,
  CreateRunInput,
  EvidenceInput,
  FinishActionInput,
  LaneActionRecordV2,
  LaneAttemptRecord,
  LaneControlRecord,
  LaneLease,
  LaneNotificationClaim,
  LaneRunRecord,
  LaneSnapshotV2,
  LaneStateStore,
  LeaseCredentials,
  ProviderHealthInput,
  NotificationClaimInput,
  TransitionRunInput,
  UpdateAttemptInput,
  LaneHumanApproval,
} from "./state-store.js";
import { LaneStateStoreError } from "./state-store.js";
import type { LaneManifestV2 } from "./manifest.js";
import { approvalHeaders, readBoundedText, visibleLine } from "./approval-channel.js";

/** A status snapshot carries every run and attempt plus up to 1000 events. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** A control echoes its payload, at most a 1 MiB retirement evidence packet. */
const MAX_CONTROL_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Command Center's own words are passed on, but never more than a line of them. */
const MAX_DETAIL_CHARS = 200;

type HttpStoreOptions = {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class HttpLaneStateStore implements LaneStateStore {
  readonly kind = "http" as const;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  }

  private async request<T>(
    method: "GET" | "POST",
    endpoint: string,
    body?: Record<string, unknown>,
    approval?: LaneHumanApproval
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "x-api-key": this.apiKey,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    // Human proof travels only on human-gated controls, never on worker calls.
    if (approval) Object.assign(headers, approvalHeaders(approval));
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        // Every request carries the service key, and a control can carry the
        // approval channel key and grant: none of them may follow a redirect.
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new LaneStateStoreError(
        `Command Center lane request failed closed: ${visibleLine((error as Error).message, MAX_DETAIL_CHARS)}`
      );
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new LaneStateStoreError(
        `Command Center lane request failed closed: redirect refused (HTTP ${response.status})`,
        response.status
      );
    }
    let text: string;
    try {
      text = await readBoundedText(
        response,
        approval ? Math.min(MAX_CONTROL_RESPONSE_BYTES, this.maxResponseBytes) : this.maxResponseBytes
      );
    } catch {
      throw new LaneStateStoreError(
        "Command Center lane request failed closed: the response was unreadable or too large",
        response.status
      );
    }
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text.slice(0, 500);
      }
    }
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "detail" in payload
          ? visibleLine(String((payload as { detail: unknown }).detail), MAX_DETAIL_CHARS)
          : "";
      throw new LaneStateStoreError(
        `Command Center lane request rejected: ${detail || `HTTP ${response.status}`}`,
        response.status,
        payload
      );
    }
    return payload as T;
  }

  async claimLease(input: {
    ownerId: string;
    ownerSite: "mac" | "ovh";
    leaseSeconds?: number;
  }): Promise<LaneLease | null> {
    try {
      return await this.request<LaneLease>("POST", "/api/conductor/lanes/lease/claim", {
        owner_id: input.ownerId,
        owner_site: input.ownerSite,
        lease_name: "growth",
        lease_seconds: input.leaseSeconds ?? 75,
      });
    } catch (error) {
      if (error instanceof LaneStateStoreError && error.conflict) return null;
      throw error;
    }
  }

  renewLease(
    lease: LeaseCredentials,
    heartbeat: Record<string, unknown>,
    leaseSeconds = 75
  ): Promise<LaneLease> {
    return this.request("POST", "/api/conductor/lanes/lease/renew", {
      ...lease,
      lease_seconds: leaseSeconds,
      heartbeat,
    });
  }

  async releaseLease(lease: LeaseCredentials): Promise<void> {
    await this.request("POST", "/api/conductor/lanes/lease/release", lease);
  }

  snapshot(sinceEventSeq = 0): Promise<LaneSnapshotV2> {
    return this.request(
      "GET",
      `/api/conductor/lanes/status?since_event_seq=${Math.max(0, sinceEventSeq)}`
    );
  }

  stageManifest(
    lease: LeaseCredentials,
    input: {
      revisionId: string;
      sourceRef: string;
      manifest: LaneManifestV2;
      createdBy: string;
    }
  ): Promise<Record<string, unknown>> {
    const { manifestPath: _manifestPath, manifestHash, ...manifest } = input.manifest;
    return this.request("POST", "/api/conductor/lanes/manifests", {
      ...lease,
      revision_id: input.revisionId,
      source_ref: input.sourceRef,
      manifest_hash: manifestHash,
      manifest,
      created_by: input.createdBy,
    });
  }

  activateManifest(
    lease: LeaseCredentials,
    revisionId: string,
    expectedManifestVersion: number
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/conductor/lanes/manifests/activate", {
      ...lease,
      revision_id: revisionId,
      expected_manifest_version: expectedManifestVersion,
    });
  }

  createRun(
    lease: LeaseCredentials,
    input: CreateRunInput
  ): Promise<LaneRunRecord> {
    return this.request("POST", "/api/conductor/lanes/runs", {
      ...lease,
      ...input,
      metadata: input.metadata ?? {},
      legacy_verified: input.legacy_verified ?? false,
    });
  }

  transitionRun(
    lease: LeaseCredentials,
    runId: string,
    input: TransitionRunInput
  ): Promise<LaneRunRecord> {
    return this.request(
      "POST",
      `/api/conductor/lanes/runs/${encodeURIComponent(runId)}/transition`,
      { ...lease, ...input, patch: input.patch ?? {} }
    );
  }

  beginAttempt(
    lease: LeaseCredentials,
    runId: string,
    input: BeginAttemptInput
  ): Promise<LaneAttemptRecord> {
    return this.request(
      "POST",
      `/api/conductor/lanes/runs/${encodeURIComponent(runId)}/attempts`,
      { ...lease, ...input }
    );
  }

  updateAttempt(
    lease: LeaseCredentials,
    attemptId: string,
    input: UpdateAttemptInput
  ): Promise<LaneAttemptRecord> {
    return this.request(
      "POST",
      `/api/conductor/lanes/attempts/${encodeURIComponent(attemptId)}`,
      { ...lease, ...input, result: input.result ?? {} }
    );
  }

  beginAction(
    lease: LeaseCredentials,
    runId: string,
    input: BeginActionInput
  ): Promise<LaneActionRecordV2> {
    return this.request(
      "POST",
      `/api/conductor/lanes/runs/${encodeURIComponent(runId)}/actions`,
      { ...lease, ...input }
    );
  }

  finishAction(
    lease: LeaseCredentials,
    actionId: string,
    input: FinishActionInput
  ): Promise<LaneActionRecordV2> {
    return this.request(
      "POST",
      `/api/conductor/lanes/actions/${encodeURIComponent(actionId)}/finish`,
      { ...lease, ...input, result: input.result ?? {} }
    );
  }

  recordEvidence(
    lease: LeaseCredentials,
    runId: string,
    input: EvidenceInput
  ): Promise<Record<string, unknown>> {
    return this.request(
      "POST",
      `/api/conductor/lanes/runs/${encodeURIComponent(runId)}/evidence`,
      { ...lease, ...input }
    );
  }

  recordProviderHealth(
    lease: LeaseCredentials,
    input: ProviderHealthInput
  ): Promise<Record<string, unknown>> {
    return this.request("POST", "/api/conductor/lanes/providers/health", {
      ...lease,
      ...input,
    });
  }

  claimNotification(
    lease: LeaseCredentials,
    input: NotificationClaimInput
  ): Promise<LaneNotificationClaim> {
    return this.request("POST", "/api/conductor/lanes/notifications/claim", {
      ...lease,
      ...input,
    });
  }

  createControl(input: {
    control_id: string;
    idempotency_key: string;
    kind: string;
    lane_id?: string;
    requested_by: string;
    payload?: Record<string, unknown>;
    approval?: LaneHumanApproval;
  }): Promise<LaneControlRecord> {
    const { approval, ...control } = input;
    return this.request(
      "POST",
      "/api/conductor/lanes/controls",
      { ...control, payload: input.payload ?? {} },
      approval
    );
  }

  finishControl(
    lease: LeaseCredentials,
    controlId: string,
    input: {
      expected_version: number;
      expected_controller_version: number;
      status: "applied" | "rejected";
      result?: Record<string, unknown>;
    }
  ): Promise<LaneControlRecord> {
    return this.request(
      "POST",
      `/api/conductor/lanes/controls/${encodeURIComponent(controlId)}/finish`,
      { ...lease, ...input, result: input.result ?? {} }
    );
  }

  async close(): Promise<void> {
    // Native fetch has no per-client resources to close.
  }
}
