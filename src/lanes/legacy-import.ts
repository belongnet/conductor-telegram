import { readFileSync } from "node:fs";
import { z } from "zod";
import { githubPrIdentity, refreshPrByUrl, type GithubPrPolicySnapshot } from "../bot/github.js";
import type {
  ConductorApiMessage,
  ConductorApiProject,
  ConductorApiSession,
  ConductorApiWorkspace,
} from "../integrations/conductor-api.js";
import { conductorWorkspaceIsArchived } from "../integrations/conductor-api.js";
import { deterministicLaneId } from "./controller-policy.js";
import { rawExecutionReceipts } from "./validation-evidence.js";
import type { GithubLaneGateway } from "./controller.js";
import type { LaneManifestV2, ManifestProvider } from "./manifest.js";
import type {
  LaneLease,
  LaneRunRecord,
  LaneSnapshotV2,
  LaneStateStore,
} from "./state-store.js";
import { repositoryRemoteIdentity } from "./repository-identity.js";

const LegacyLaneSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    provider: z.enum(["claude", "codex", "cursor"]),
    repo_url: z.string().url(),
    prompt: z.string().optional(),
    workspace_id: z.string().optional(),
    session_id: z.string().optional(),
    pr_url: z.string().url().optional(),
  })
  .passthrough();

const LegacyQueueSchema = z
  .object({
    lanes: z.array(LegacyLaneSchema),
    watch: z.unknown().optional(),
  })
  .passthrough();

export type LegacyLane = z.infer<typeof LegacyLaneSchema>;

export interface LegacyConductorGateway {
  listProjects(): Promise<ConductorApiProject[]>;
  listProjectWorkspaces(projectId: string): Promise<ConductorApiWorkspace[]>;
  getWorkspace(workspaceId: string): Promise<ConductorApiWorkspace>;
  listWorkspaceSessions(
    workspaceId: string,
    options?: { includeArchived?: boolean }
  ): Promise<ConductorApiSession[]>;
  getSessionMessageTail(sessionId: string, limit: number): Promise<ConductorApiMessage[]>;
  getSessionStatus(sessionId: string): Promise<{ status: "idle" | "working" | "error" }>;
}

export type LegacyCandidate = {
  workspaceId: string;
  workspaceName: string;
  sessionId: string | null;
  archived: boolean;
  working: boolean;
  verifiedProgress: boolean;
  prHeadLinked: boolean;
  lastActivityAt: string;
  recognizedLegacyTag: boolean;
  ambiguousSession?: boolean;
};

export type LegacyImportLanePlan = {
  laneId: string;
  disposition: "adopt" | "quarantine" | "skip";
  reason: string;
  provider: ManifestProvider;
  workspace: LegacyCandidate | null;
  pr: GithubPrPolicySnapshot | null;
  legacyVerified: boolean;
  gitTruthVerified: boolean;
  candidates: LegacyCandidate[];
};

export type LegacyImportPlan = {
  source: string;
  ignoredWatchEntries: number;
  lanes: LegacyImportLanePlan[];
  duplicateLaneIds: string[];
  duplicateWorkspaceIds: string[];
  duplicatePrUrls: string[];
};

type InspectedCandidate = {
  candidate: LegacyCandidate;
  legacyPipelineTagged: boolean;
  searchable: string;
  prUrls: string[];
  sessions: InspectedSession[];
};

type InspectedSession = {
  session: ConductorApiSession;
  searchable: string;
  working: boolean;
  uncertain: boolean;
  verifiedProgress: boolean;
  lastActivityAt: string;
};

const GITHUB_PR_URL =
  /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/gi;
const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

function normalizeRepo(url: string): string | null {
  const identity = repositoryRemoteIdentity(url);
  return identity?.startsWith("github.com/")
    ? identity.slice("github.com/".length)
    : null;
}

function hasVerifiedProgress(messages: readonly ConductorApiMessage[]): boolean {
  return rawExecutionReceipts(messages).length > 0;
}

function laneNameMatches(name: string, laneId: string): boolean {
  const escaped = laneId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `\\[(?:lane|review|final|merge|validate):${escaped}(?::|\\])`,
    "i"
  ).test(name);
}

function sessionMatchesPr(
  session: InspectedSession,
  pr: GithubPrPolicySnapshot | null
): boolean {
  const exactPr = pr?.url.toLowerCase();
  const exactHead = pr?.headSha?.toLowerCase();
  return Boolean(
    exactPr &&
      exactHead &&
      session.searchable.includes(exactPr) &&
      session.searchable.includes(exactHead)
  );
}

function refreshWorkspaceSession(
  inspected: InspectedCandidate,
  pr: GithubPrPolicySnapshot | null
): void {
  const linked = inspected.sessions.filter((session) =>
    sessionMatchesPr(session, pr)
  );
  const verified = inspected.sessions.filter(
    (session) => session.verifiedProgress
  );
  const pool = linked.length > 0 ? linked : verified;
  const working = inspected.sessions.filter((session) => session.working);
  const uncertain = inspected.sessions.some((session) => session.uncertain);
  const sorted = [...pool].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt)
  );
  let chosen = sorted[0];
  let ambiguous = uncertain || working.length > 1;
  if (
    sorted.length > 1 &&
    sorted[0].lastActivityAt === sorted[1].lastActivityAt
  ) {
    ambiguous = true;
  }
  if (working.length === 1) {
    if (pool.includes(working[0])) chosen = working[0];
    else ambiguous = true;
  }
  inspected.candidate.sessionId = ambiguous ? null : chosen?.session.id ?? null;
  inspected.candidate.working = working.length > 0;
  inspected.candidate.verifiedProgress = Boolean(
    !ambiguous &&
      chosen &&
      (chosen.verifiedProgress || sessionMatchesPr(chosen, pr))
  );
  inspected.candidate.prHeadLinked = Boolean(
    !ambiguous && chosen && sessionMatchesPr(chosen, pr)
  );
  // Legacy pipeline names become trusted archive tags only after the importer
  // proves the old queue lane, matching repository project, exact PR URL, and
  // current head SHA through the selected session transcript. A familiar name
  // alone is never archive authority.
  inspected.candidate.recognizedLegacyTag = Boolean(
    inspected.legacyPipelineTagged && inspected.candidate.prHeadLinked
  );
  inspected.candidate.ambiguousSession = ambiguous;
}

async function inspectWorkspace(input: {
  conductor: LegacyConductorGateway;
  lane: LegacyLane;
  workspace: ConductorApiWorkspace;
  pr: GithubPrPolicySnapshot | null;
}): Promise<InspectedCandidate> {
  const sessions = await input.conductor.listWorkspaceSessions(input.workspace.id, {
    includeArchived: true,
  });
  const usableSessions = sessions.filter((session) => !session.archivedAt);
  const inspectedSessions: InspectedSession[] = [];
  for (const session of usableSessions) {
    let messages: ConductorApiMessage[] = [];
    let working = true;
    let uncertain = true;
    try {
      const [fetchedMessages, status] = await Promise.all([
        input.conductor.getSessionMessageTail(session.id, 100),
        input.conductor.getSessionStatus(session.id),
      ]);
      messages = fetchedMessages;
      working = status.status === "working";
      uncertain = false;
    } catch {
      // An unreadable live session may still be mutating the workspace. It is
      // therefore ambiguity, never evidence that a different session is safe.
    }
    const searchable = JSON.stringify(messages).toLowerCase();
    const newestMessage = [...messages]
      .map((message) => message.receivedAt)
      .sort((left, right) => right.localeCompare(left))[0];
    inspectedSessions.push({
      session,
      searchable,
      working,
      uncertain,
      verifiedProgress: hasVerifiedProgress(messages),
      lastActivityAt:
        newestMessage ?? session.createdAt ?? input.workspace.createdAt,
    });
  }
  const searchable = inspectedSessions
    .map((session) => session.searchable)
    .join("\n");
  const legacyPipelineTagged = laneNameMatches(
    input.workspace.name,
    input.lane.id
  );
  const inspected: InspectedCandidate = {
    candidate: {
      workspaceId: input.workspace.id,
      workspaceName: input.workspace.name,
      sessionId: null,
      archived: conductorWorkspaceIsArchived(input.workspace),
      working: false,
      verifiedProgress: false,
      prHeadLinked: false,
      lastActivityAt:
        input.workspace.lastActivityAt ?? input.workspace.createdAt ?? "1970-01-01T00:00:00Z",
      recognizedLegacyTag: false,
    },
    legacyPipelineTagged,
    searchable,
    prUrls: [...new Set(searchable.match(GITHUB_PR_URL) ?? [])],
    sessions: inspectedSessions,
  };
  refreshWorkspaceSession(inspected, input.pr);
  return inspected;
}

function chooseCandidate(candidates: LegacyCandidate[]): {
  chosen: LegacyCandidate | null;
  ambiguous: boolean;
  reason: string;
} {
  const live = candidates.filter((candidate) => !candidate.archived);
  const working = live.filter((candidate) => candidate.working);
  if (
    live.some((candidate) => candidate.ambiguousSession) ||
    working.length > 1
  ) {
    return {
      chosen: null,
      ambiguous: true,
      reason: "multiple, unreadable, or simultaneously working session candidates",
    };
  }
  const usable = candidates.filter(
    (candidate) => !candidate.archived && candidate.verifiedProgress
  );
  const linked = usable.filter((candidate) => candidate.prHeadLinked);
  const pool = linked.length > 0 ? linked : usable;
  if (pool.length === 0) {
    if (working.length === 1) {
      return {
        chosen: null,
        ambiguous: true,
        reason: "a working session has no verifiable progress binding",
      };
    }
    return { chosen: null, ambiguous: false, reason: "no unarchived workspace with verified progress" };
  }
  const sorted = [...pool].sort((left, right) =>
    right.lastActivityAt.localeCompare(left.lastActivityAt)
  );
  const top = sorted[0];
  const equallyCurrent = sorted.filter(
    (candidate) => candidate.lastActivityAt === top.lastActivityAt
  );
  if (
    equallyCurrent.length > 1 ||
    (working.length === 1 && working[0].workspaceId !== top.workspaceId)
  ) {
    return {
      chosen: null,
      ambiguous: true,
      reason: "multiple equally authoritative or simultaneously working candidates",
    };
  }
  return {
    chosen: top,
    ambiguous: false,
    reason: linked.length > 0 ? "current PR head transcript match" : "newest verified progress",
  };
}

export async function planLegacyImport(input: {
  sourcePath: string;
  manifest: LaneManifestV2;
  conductor: LegacyConductorGateway;
  github?: Pick<GithubLaneGateway, "refreshPr">;
}): Promise<LegacyImportPlan> {
  const raw = JSON.parse(readFileSync(input.sourcePath, "utf8")) as unknown;
  const queue = LegacyQueueSchema.parse(raw);
  const laneCounts = new Map<string, number>();
  for (const lane of queue.lanes) {
    laneCounts.set(lane.id, (laneCounts.get(lane.id) ?? 0) + 1);
  }
  const duplicateLaneIds = [...laneCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([laneId]) => laneId)
    .sort();
  const github = input.github ?? { refreshPr: refreshPrByUrl };
  const projects = await input.conductor.listProjects();
  const plans: LegacyImportLanePlan[] = [];
  for (const legacy of queue.lanes) {
    const configured = input.manifest.lanes.find((lane) => lane.id === legacy.id);
    if (!configured) {
      plans.push({
        laneId: legacy.id,
        disposition: "skip",
        reason: "lane is absent from Manifest v2",
        provider: legacy.provider,
        workspace: null,
        pr: null,
        legacyVerified: false,
        gitTruthVerified: false,
        candidates: [],
      });
      continue;
    }
    const expectedRepo = `${configured.repository.owner}/${configured.repository.name}`.toLowerCase();
    if (normalizeRepo(legacy.repo_url) !== expectedRepo) {
      plans.push({
        laneId: legacy.id,
        disposition: "quarantine",
        reason: "legacy queue repository does not match Manifest v2",
        provider: legacy.provider,
        workspace: null,
        pr: null,
        legacyVerified: false,
        gitTruthVerified: false,
        candidates: [],
      });
      continue;
    }
    let pr: GithubPrPolicySnapshot | null = null;
    if (legacy.pr_url) {
      try {
        pr = await github.refreshPr(legacy.pr_url);
        const identity = githubPrIdentity(pr.url);
        if (
          identity?.owner !== configured.repository.owner.toLowerCase() ||
          identity.repo !== configured.repository.name.toLowerCase() ||
          pr.baseBranch !== configured.repository.base_branch
        ) {
          pr = null;
        }
      } catch {
        pr = null;
      }
    }
    const matchingProjects = projects.filter(
      (candidate) => normalizeRepo(candidate.gitRemote) === expectedRepo
    );
    if (matchingProjects.length > 1) {
      plans.push({
        laneId: legacy.id,
        disposition: "quarantine",
        reason: "multiple Conductor projects match the legacy repository",
        provider: legacy.provider,
        workspace: null,
        pr,
        legacyVerified: false,
        gitTruthVerified: false,
        candidates: [],
      });
      continue;
    }
    const project = matchingProjects[0];
    const workspaceMap = new Map<string, ConductorApiWorkspace>();
    if (project) {
      for (const workspace of await input.conductor.listProjectWorkspaces(project.id)) {
        workspaceMap.set(workspace.id, workspace);
      }
    }
    // A pinned ID is eligible only when the matching repository project's
    // workspace listing also contains it. getWorkspace(id) alone cannot prove
    // repository ownership and must never bypass this adoption boundary.
    const likely = [...workspaceMap.values()].filter(
      (workspace) =>
        workspace.id === legacy.workspace_id ||
        laneNameMatches(workspace.name, legacy.id)
    );
    const inspected: InspectedCandidate[] = [];
    for (const workspace of likely) {
      inspected.push(
        await inspectWorkspace({ conductor: input.conductor, lane: legacy, workspace, pr })
      );
    }
    if (!pr) {
      const newestFirst = [...inspected].sort((left, right) =>
        right.candidate.lastActivityAt.localeCompare(left.candidate.lastActivityAt)
      );
      candidateSearch: for (const item of newestFirst) {
        for (const url of [...item.prUrls].reverse()) {
          try {
            const discovered = await github.refreshPr(url);
            const identity = githubPrIdentity(discovered.url);
            if (
              identity?.owner === configured.repository.owner.toLowerCase() &&
              identity.repo === configured.repository.name.toLowerCase() &&
              discovered.baseBranch === configured.repository.base_branch
            ) {
              pr = discovered;
              break candidateSearch;
            }
          } catch {
            // Git truth is optional during discovery; the lane remains resumable.
          }
        }
      }
    }
    if (pr) {
      for (const item of inspected) {
        refreshWorkspaceSession(item, pr);
      }
    }
    const candidates = inspected.map((item) => item.candidate);
    const selection = chooseCandidate(candidates);
    const prIdentityComplete = Boolean(
      pr &&
        pr.prNumber &&
        pr.headBranch &&
        pr.headSha &&
        FULL_SHA_RE.test(pr.headSha)
    );
    const unsupportedPrState = Boolean(
      pr &&
        (pr.state === "closed" ||
          !prIdentityComplete ||
          (pr.state === "merged" &&
            (!pr.mergeCommitSha || !FULL_SHA_RE.test(pr.mergeCommitSha))))
    );
    const gitTruthVerified = Boolean(
      prIdentityComplete &&
      pr &&
      pr.baseBranch === configured.repository.base_branch &&
      normalizeRepo(legacy.repo_url) === expectedRepo
    );
    const legacyVerified = Boolean(
      selection.chosen &&
      selection.chosen.recognizedLegacyTag &&
      selection.chosen.prHeadLinked &&
      gitTruthVerified &&
      pr &&
      normalizeRepo(legacy.repo_url) === expectedRepo &&
      (!legacy.pr_url || pr.url.toLowerCase() === legacy.pr_url.toLowerCase())
    );
    const mergedButWorking = Boolean(
      selection.chosen?.working && pr?.state === "merged"
    );
    const mergedGitTruthWithoutLiveWorkspace = Boolean(
      !selection.ambiguous &&
        !selection.chosen &&
        pr?.state === "merged" &&
        gitTruthVerified &&
        pr.mergeCommitSha &&
        FULL_SHA_RE.test(pr.mergeCommitSha) &&
        candidates.every((candidate) => candidate.archived)
    );
    plans.push({
      laneId: legacy.id,
      disposition:
        selection.ambiguous ||
        (!selection.chosen && !mergedGitTruthWithoutLiveWorkspace) ||
        mergedButWorking ||
        unsupportedPrState
          ? "quarantine"
          : "adopt",
      reason: unsupportedPrState
        ? "Git truth is incomplete or the pull request is closed without merge"
        : mergedButWorking
          ? "candidate session is still working after its PR merged"
          : mergedGitTruthWithoutLiveWorkspace
            ? "exact merged Git truth; all legacy workspace candidates are archived"
          : selection.reason,
      provider: legacy.provider,
      workspace: selection.chosen,
      pr,
      legacyVerified,
      gitTruthVerified,
      candidates,
    });
  }

  const collisionWinner = (
    colliding: LegacyImportLanePlan[]
  ): LegacyImportLanePlan | null => {
    // A duplicate PR with no live workspace has no lane-specific progress
    // signal that can choose an owner safely. Exact Git truth proves the PR,
    // not which duplicate queue entry owns it, so quarantine the ambiguity.
    const withWorkspace = colliding.filter(
      (lane): lane is LegacyImportLanePlan & { workspace: LegacyCandidate } =>
        lane.workspace !== null
    );
    if (withWorkspace.length === 0) return null;
    const linked = withWorkspace.filter((lane) => lane.workspace.prHeadLinked);
    const pool = linked.length > 0 ? linked : withWorkspace;
    if (pool.filter((lane) => lane.workspace?.working).length > 1) return null;
    const sorted = [...pool].sort((left, right) =>
      right.workspace!.lastActivityAt.localeCompare(
        left.workspace!.lastActivityAt
      )
    );
    if (
      sorted.length > 1 &&
      sorted[0].workspace!.lastActivityAt ===
        sorted[1].workspace!.lastActivityAt
    ) {
      return null;
    }
    return sorted[0] ?? null;
  };
  const quarantineCollision = (
    colliding: LegacyImportLanePlan[],
    label: string
  ) => {
    const winner = collisionWinner(colliding);
    for (const lane of colliding) {
      if (lane === winner) continue;
      lane.disposition = "quarantine";
      lane.reason = `${label} also claimed by ${colliding
        .filter((other) => other !== lane)
        .map((other) => other.laneId)
        .join(", ")}`;
      lane.workspace = null;
    }
  };

  for (const lane of plans.filter((plan) => duplicateLaneIds.includes(plan.laneId))) {
    lane.disposition = "quarantine";
    lane.reason = `legacy queue contains duplicate entries for lane ${lane.laneId}`;
    lane.workspace = null;
  }

  const chosenWorkspaces = new Map<string, LegacyImportLanePlan[]>();
  for (const lane of plans.filter((plan) => plan.disposition === "adopt")) {
    if (!lane.workspace) continue;
    const entries = chosenWorkspaces.get(lane.workspace.workspaceId) ?? [];
    entries.push(lane);
    chosenWorkspaces.set(lane.workspace.workspaceId, entries);
  }
  const duplicateWorkspaceIds = [...chosenWorkspaces.entries()]
    .filter(([, lanes]) => lanes.length > 1)
    .map(([workspaceId]) => workspaceId)
    .sort();
  for (const workspaceId of duplicateWorkspaceIds) {
    quarantineCollision(
      chosenWorkspaces.get(workspaceId)!,
      `workspace ${workspaceId}`
    );
  }

  const chosenPrs = new Map<string, LegacyImportLanePlan[]>();
  for (const lane of plans.filter((plan) => plan.disposition === "adopt")) {
    if (!lane.pr?.url) continue;
    const prUrl = lane.pr.url.toLowerCase();
    const entries = chosenPrs.get(prUrl) ?? [];
    entries.push(lane);
    chosenPrs.set(prUrl, entries);
  }
  const duplicatePrUrls = [...chosenPrs.entries()]
    .filter(([, lanes]) => lanes.length > 1)
    .map(([prUrl]) => prUrl)
    .sort();
  for (const prUrl of duplicatePrUrls) {
    quarantineCollision(chosenPrs.get(prUrl)!, `PR ${prUrl}`);
  }
  return {
    source: input.sourcePath,
    ignoredWatchEntries: Array.isArray(queue.watch) ? queue.watch.length : 0,
    lanes: plans,
    duplicateLaneIds,
    duplicateWorkspaceIds,
    duplicatePrUrls,
  };
}

async function latestRun(
  store: LaneStateStore,
  runId: string
): Promise<LaneRunRecord> {
  const run = (await store.snapshot()).runs.find((candidate) => candidate.run_id === runId);
  if (!run) throw new Error(`imported run disappeared: ${runId}`);
  return run;
}

export async function applyLegacyImport(input: {
  plan: LegacyImportPlan;
  manifest: LaneManifestV2;
  store: LaneStateStore;
  lease: LaneLease;
  snapshot?: LaneSnapshotV2;
}): Promise<{ imported: number; quarantined: number; skipped: number }> {
  let snapshot = input.snapshot ?? (await input.store.snapshot());
  if (!snapshot.manifest || snapshot.manifest.manifest_hash !== input.manifest.manifestHash) {
    throw new Error("Manifest v2 must be active before applying the legacy import");
  }
  if (snapshot.controller?.mode === "active") {
    throw new Error(
      "legacy import requires the controller to remain shadow/disabled/paused until cutover"
    );
  }
  const plannedActiveByProvider = new Map<ManifestProvider, number>();
  for (const planned of input.plan.lanes) {
    if (
      planned.disposition !== "adopt" ||
      !planned.workspace?.working ||
      planned.pr?.state === "merged" ||
      snapshot.runs.some((run) => run.lane_id === planned.laneId)
    ) {
      continue;
    }
    plannedActiveByProvider.set(
      planned.provider,
      (plannedActiveByProvider.get(planned.provider) ?? 0) + 1
    );
  }
  for (const provider of ["claude", "codex", "cursor"] as const) {
    const active = snapshot.capacity[provider]?.active ?? 0;
    const planned = plannedActiveByProvider.get(provider) ?? 0;
    const limit = input.manifest.global.provider_capacity[provider];
    if (active + planned > limit) {
      throw new Error(
        `legacy import would exceed ${provider} capacity ${active + planned}/${limit}; quarantine or stop ambiguous working sessions first`
      );
    }
  }
  const manifestRevisionId = snapshot.manifest.revision_id;
  let imported = 0;
  let quarantined = 0;
  let skipped = 0;
  for (const planned of input.plan.lanes) {
    if (planned.disposition === "skip") {
      skipped += 1;
      continue;
    }
    if (snapshot.runs.some((run) => run.lane_id === planned.laneId)) {
      skipped += 1;
      continue;
    }
    const lane = input.manifest.lanes.find((candidate) => candidate.id === planned.laneId);
    if (!lane) {
      skipped += 1;
      continue;
    }
    const runId = deterministicLaneId(
      "run",
      manifestRevisionId,
      lane.id,
      "legacy-1"
    );
    let run = await input.store.createRun(input.lease, {
      run_id: runId,
      manifest_revision_id: manifestRevisionId,
      lane_id: lane.id,
      generation: 1,
      priority: lane.priority,
      legacy_verified: planned.legacyVerified,
      metadata: {
        imported_from: input.plan.source,
        import_reason: planned.reason,
        legacy_candidates: planned.candidates.map((candidate) => candidate.workspaceId),
        legacy_git_verified: planned.gitTruthVerified,
        adopt_existing_session: Boolean(planned.workspace?.sessionId),
        legacy_session_provider: planned.provider,
      },
    });
    if (planned.disposition === "quarantine") {
      await input.store.transitionRun(input.lease, runId, {
        expected_version: run.row_version,
        from_status: "queued",
        to_status: "quarantined",
        stage: "legacy-import",
        patch: {
          metadata: { ...run.metadata_json, quarantine_reason: planned.reason },
        },
      });
      quarantined += 1;
      snapshot = await input.store.snapshot();
      continue;
    }
    const binding = {
      author_provider: planned.provider,
      provider: planned.provider,
      model: input.manifest.global.provider_models[planned.provider],
      workspace_id: planned.workspace?.workspaceId ?? null,
      workspace_name: planned.workspace?.workspaceName ?? null,
      session_id: planned.workspace?.sessionId ?? null,
      pr_number: planned.pr?.prNumber ?? null,
      pr_url: planned.pr?.url ?? null,
      head_branch: planned.pr?.headBranch ?? null,
      head_sha: planned.pr?.headSha ?? null,
      merged_sha: planned.pr?.mergeCommitSha ?? null,
      metadata: {
        ...run.metadata_json,
        author_session_id: planned.workspace?.sessionId ?? null,
      },
    };
    if (planned.pr?.state === "merged" && planned.pr.mergeCommitSha) {
      await input.store.transitionRun(input.lease, runId, {
        expected_version: run.row_version,
        from_status: "queued",
        to_status: "validating",
        stage: "validation",
        patch: binding,
      });
    } else {
      run = await input.store.transitionRun(input.lease, runId, {
        expected_version: run.row_version,
        from_status: "queued",
        to_status: "implementing",
        stage: "implementation",
        patch: binding,
      });
      if (
        planned.pr?.state === "open" &&
        planned.pr.headSha &&
        !planned.workspace?.working
      ) {
        await input.store.transitionRun(input.lease, runId, {
          expected_version: run.row_version,
          from_status: "implementing",
          to_status: "pr_bound",
          stage: "pr",
          patch: binding,
        });
      } else if (planned.workspace?.working && planned.workspace.sessionId) {
        const current = await latestRun(input.store, runId);
        const attempt = await input.store.beginAttempt(input.lease, runId, {
          attempt_id: deterministicLaneId(
            "attempt",
            runId,
            "legacy-implementation",
            planned.provider
          ),
          expected_run_version: current.row_version,
          stage: "implementation",
          attempt_number: 1,
          role: "implementation",
          provider: planned.provider,
          model: input.manifest.global.provider_models[planned.provider],
          nonce: deterministicLaneId(
            "nonce",
            runId,
            "legacy-implementation",
            planned.provider
          ),
          workspace_id: planned.workspace.workspaceId,
          session_id: planned.workspace.sessionId,
        });
        const afterAttempt = await latestRun(input.store, runId);
        await input.store.updateAttempt(input.lease, attempt.attempt_id, {
          expected_attempt_version: attempt.row_version,
          expected_run_version: afterAttempt.row_version,
          status: "working",
          workspace_id: planned.workspace.workspaceId,
          session_id: planned.workspace.sessionId,
          result: { adopted_legacy_session: true },
        });
      }
    }
    if (planned.pr?.headSha) {
      const current = await latestRun(input.store, runId);
      await input.store.recordEvidence(input.lease, runId, {
        evidence_id: deterministicLaneId(
          "evidence",
          "legacy-pr-binding",
          runId,
          planned.pr.url,
          planned.pr.headSha
        ),
        external_key: `legacy-pr-binding:${runId}:${planned.pr.url}:${planned.pr.headSha}`,
        expected_run_version: current.row_version,
        evidence_type: "pr_binding",
        repo_owner: current.repo_owner,
        repo_name: current.repo_name,
        head_sha: planned.pr.headSha,
        evidence: {
          owner: current.repo_owner,
          repo: current.repo_name,
          base_branch: current.base_branch,
          pr_url: planned.pr.url,
          pr_number: planned.pr.prNumber,
          head_branch: planned.pr.headBranch,
          head_sha: planned.pr.headSha,
        },
      });
    }
    imported += 1;
    snapshot = await input.store.snapshot();
    void (await latestRun(input.store, runId));
  }
  return { imported, quarantined, skipped };
}
