import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ConductorApiError,
  createConductorApiClientFromEnv,
  type ConductorApiClient,
  type ConductorApiMessage,
  type ConductorApiWorkspace,
} from "../integrations/conductor-api.js";
import { createLogger } from "../bot/logger.js";
import { supervisedInterval } from "../bot/supervisor.js";
import {
  countLaneActions,
  getLaneDeliveryState,
  getLanesLastTickAt,
  getLatestLaneActions,
  isLanesPaused,
  observeLaneSession,
  recordLaneAction,
  recordLaneSessionNudge,
  setLaneProviderOutage,
  setLanesLastTickAt,
  type LaneActionRecord,
} from "../store/queries.js";
import {
  LanesConfigError,
  loadLanesConfig,
  providerNames,
  type LaneConfig,
  type LanesConfig,
} from "./config.js";
import {
  LANE_NUDGE_MESSAGE,
  assistantTextFromTranscriptEvent,
  decideLaneActions,
  deriveLaneRuntimeState,
  githubPrUrlFromText,
  laneWorkspaceName,
  laneWorkspaceNamePrefix,
  parseLaneWorkspaceName,
  type LaneAction,
  type LaneRuntimeState,
  type LaneSnapshot,
} from "./decide.js";
import {
  getLaneStageView,
  mergeDependencyBlockers,
  parseRateLimitReset,
  runDeliveryPipeline,
  runLaneHygiene,
  type LaneDeliveryState,
} from "./pipeline.js";

const log = createLogger("lanes");
const DUE_CHECK_MS = 60_000;
const INVALID_CONFIG_LOG_MS = 30 * 60_000;

export class LaneWorkspaceIndexError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "LaneWorkspaceIndexError";
    if (options?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export type LaneStatusRow = {
  id: string;
  title: string;
  provider: string;
  assignedProvider: string | null;
  state: LaneRuntimeState;
  lastAction: LaneActionRecord | null;
  deliveryStage: string;
};

export type LanesTickResult = {
  skipped: boolean;
  reason?: string;
  actions: LaneAction[];
  statuses: LaneStatusRow[];
};

export type LanesNotify = (text: string) => Promise<void>;

let tickInFlight = false;
let lastInvalidConfigLog = { message: "", at: 0 };

export function startLanesScheduler(options: {
  notify: LanesNotify;
}): { stop: () => void } {
  const timer = supervisedInterval(
    "lanes",
    async () => {
      await runLanesTick({ notify: options.notify, force: false });
    },
    DUE_CHECK_MS
  );
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}

export async function runLanesTick(options: {
  notify: LanesNotify;
  force: boolean;
}): Promise<LanesTickResult> {
  if (tickInFlight) {
    return {
      skipped: true,
      reason: "A lanes tick is already running.",
      actions: [],
      statuses: [],
    };
  }
  tickInFlight = true;
  try {
    return await runLanesTickUnlocked(options);
  } catch (error) {
    log.error("tick failed:", error);
    return {
      skipped: true,
      reason: describeError(error),
      actions: [],
      statuses: [],
    };
  } finally {
    tickInFlight = false;
  }
}

async function runLanesTickUnlocked(options: {
  notify: LanesNotify;
  force: boolean;
}): Promise<LanesTickResult> {
  let config: LanesConfig | null;
  try {
    config = loadLanesConfig();
  } catch (error) {
    const message =
      error instanceof LanesConfigError
        ? error.message
        : describeError(error);
    logInvalidConfig(message);
    return {
      skipped: true,
      reason: message,
      actions: [],
      statuses: [],
    };
  }
  if (!config) {
    return {
      skipped: true,
      reason: "Lanes scheduler is off — no lanes config file found.",
      actions: [],
      statuses: [],
    };
  }

  const paused = isLanesPaused();
  if (!options.force) {
    const lastTick = getLanesLastTickAt();
    if (!lastTick) {
      setLanesLastTickAt(new Date().toISOString());
      return {
        skipped: true,
        reason: "Lanes scheduler armed; waiting for the first interval.",
        actions: [],
        statuses: [],
      };
    }
    const elapsedMs = Date.now() - Date.parse(lastTick);
    if (!Number.isFinite(elapsedMs) || elapsedMs < config.intervalMinutes * 60_000) {
      return {
        skipped: true,
        actions: [],
        statuses: [],
      };
    }
    // Pause before any workspace/status/transcript walk so a scheduled
    // tick after `/lanes pause` does not keep hitting the Cloud API.
    if (paused) {
      setLanesLastTickAt(new Date().toISOString());
      return {
        skipped: true,
        reason: "Lanes scheduler is paused.",
        actions: [],
        statuses: [],
      };
    }
  }

  let client: ConductorApiClient | null;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    const message = `Lanes tick skipped: ${describeError(error)}`;
    log.error(message);
    return { skipped: true, reason: message, actions: [], statuses: [] };
  }
  if (!client) {
    const message =
      "Lanes tick skipped: Conductor Cloud API is not configured.";
    log.warn(message);
    return { skipped: true, reason: message, actions: [], statuses: [] };
  }

  let workspaces: ConductorApiWorkspace[];
  try {
    workspaces = await loadWorkspaceIndex(client, config);
  } catch (error) {
    const message = `Lanes tick skipped: ${describeError(error)}`;
    log.error(message);
    return { skipped: true, reason: message, actions: [], statuses: [] };
  }

  const snapshots = await resolveLaneSnapshots(client, config, workspaces);
  const lastActions = getLatestLaneActions(config.lanes.map((lane) => lane.id));
  const statuses = statusRows(config, snapshots, lastActions);

  if (paused && options.force) {
    return {
      skipped: true,
      reason: "Lanes scheduler is paused. /lanes resume to continue.",
      actions: [],
      statuses,
    };
  }

  const providers = providerNames(config).map((name) => ({
    name,
    gapHours: config.providers[name].gapHours,
    maxActive: config.providers[name].maxActive,
    maxNudges: config.providers[name].maxNudges,
  }));

  const failedLaneIds = new Set<string>();
  const succeededProviders = new Set<string>();
  const executed: LaneAction[] = [];

  while (true) {
    const planned = decideLaneActions({
      now: new Date(),
      paused: false,
      providers,
      lanes: snapshots,
      failedLaneIds,
    }).filter((action) => !succeededProviders.has(action.provider));
    if (planned.length === 0) break;

    const action = planned[0];
    const lane = config.lanes.find((entry) => entry.id === action.laneId);
    if (!lane) {
      failedLaneIds.add(action.laneId);
      continue;
    }

    const outcome = await executeLaneAction(
      client,
      config,
      lane,
      action,
      workspaces
    );
    if (outcome.ok) {
      succeededProviders.add(action.provider);
      executed.push(action);
      applyLocalSnapshotUpdate(snapshots, action, outcome);
    } else {
      failedLaneIds.add(action.laneId);
    }

    await notifyAction(options.notify, action, outcome);
  }

  try {
    await runDeliveryPipeline({
      client,
      config,
      snapshots,
      workspaces,
      notify: options.notify,
    });
  } catch (error) {
    log.error("delivery pipeline failed:", error);
  }
  try {
    await runLaneHygiene({
      client,
      config,
      workspaces,
      notify: options.notify,
    });
  } catch (error) {
    log.error("lane hygiene failed:", error);
  }

  setLanesLastTickAt(new Date().toISOString());
  const refreshedActions = getLatestLaneActions(
    config.lanes.map((lane) => lane.id)
  );
  return {
    skipped: false,
    actions: executed,
    statuses: statusRows(config, snapshots, refreshedActions),
  };
}

export async function collectLaneStatuses(): Promise<{
  config: LanesConfig | null;
  paused: boolean;
  reason?: string;
  statuses: LaneStatusRow[];
}> {
  let config: LanesConfig | null;
  try {
    config = loadLanesConfig();
  } catch (error) {
    return {
      config: null,
      paused: isLanesPaused(),
      reason:
        error instanceof LanesConfigError
          ? error.message
          : describeError(error),
      statuses: [],
    };
  }
  if (!config) {
    return {
      config: null,
      paused: isLanesPaused(),
      reason: "Lanes scheduler is off — no lanes config file found.",
      statuses: [],
    };
  }

  let client: ConductorApiClient | null;
  try {
    client = createConductorApiClientFromEnv();
  } catch (error) {
    return {
      config,
      paused: isLanesPaused(),
      reason: describeError(error),
      statuses: [],
    };
  }
  if (!client) {
    return {
      config,
      paused: isLanesPaused(),
      reason: "Conductor Cloud API is not configured.",
      statuses: [],
    };
  }

  try {
    const workspaces = await loadWorkspaceIndex(client, config);
    const snapshots = await resolveLaneSnapshots(client, config, workspaces);
    const lastActions = getLatestLaneActions(config.lanes.map((lane) => lane.id));
    return {
      config,
      paused: isLanesPaused(),
      statuses: statusRows(config, snapshots, lastActions),
    };
  } catch (error) {
    log.error("status collection failed:", error);
    return {
      config,
      paused: isLanesPaused(),
      reason: describeError(error),
      statuses: [],
    };
  }
}

export async function runLanesHygieneNow(options: {
  notify: LanesNotify;
}): Promise<{ archived: number; reason?: string }> {
  const config = loadLanesConfig();
  if (!config) {
    return { archived: 0, reason: "Lanes scheduler is off — no lanes config file found." };
  }
  const client = createConductorApiClientFromEnv();
  if (!client) {
    return { archived: 0, reason: "Conductor Cloud API is not configured." };
  }
  const workspaces = await loadWorkspaceIndex(client, config);
  const archived = await runLaneHygiene({
    client,
    config,
    workspaces,
    notify: options.notify,
  });
  return { archived };
}

export async function forceLaneMergeAttempt(options: {
  laneId: string;
  notify: LanesNotify;
}): Promise<{ attempted: boolean; reason?: string }> {
  const config = loadLanesConfig();
  if (!config) return { attempted: false, reason: "Lanes scheduler is off." };
  const lane = config.lanes.find(
    (entry) => entry.id.toLowerCase() === options.laneId.toLowerCase()
  );
  if (!lane) {
    return { attempted: false, reason: `Unknown lane ${options.laneId}.` };
  }
  if (!lane.delivery?.merge) {
    return { attempted: false, reason: `Lane ${lane.id} has no merge stage.` };
  }
  const state = getLaneDeliveryState<LaneDeliveryState>(lane.id);
  if (!state || state.stage !== "merge") {
    return {
      attempted: false,
      reason: `Lane ${lane.id} is not at the merge stage.`,
    };
  }
  const approvals = state.finals.filter(
    (run) => run.round === state.round && run.verdict === "approve"
  );
  if (approvals.length < 2) {
    return {
      attempted: false,
      reason: `Lane ${lane.id} needs two current final approvals.`,
    };
  }
  const states = new Map(
    config.lanes.map((entry) => [
      entry.id,
      getLaneDeliveryState<LaneDeliveryState>(entry.id),
    ])
  );
  const blockers = mergeDependencyBlockers(lane, states);
  if (blockers.length > 0) {
    return {
      attempted: false,
      reason: `Lane ${lane.id} is waiting for merged dependencies: ${blockers.join(", ")}.`,
    };
  }
  const client = createConductorApiClientFromEnv();
  if (!client) {
    return { attempted: false, reason: "Conductor Cloud API is not configured." };
  }
  const workspaces = await loadWorkspaceIndex(client, config);
  const snapshots = await resolveLaneSnapshots(client, config, workspaces);
  await runDeliveryPipeline({
    client,
    config,
    snapshots,
    workspaces,
    notify: options.notify,
    forceMergeLaneId: lane.id,
  });
  return { attempted: true };
}

type ExecuteOutcome = {
  ok: boolean;
  notice: string;
  assignedProvider?: string;
};

/** @internal exported for scheduler unit tests. */
export async function executeLaneAction(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  action: LaneAction,
  workspaces: ConductorApiWorkspace[]
): Promise<ExecuteOutcome> {
  if (action.type === "restart") {
    let workspace: ConductorApiWorkspace | null;
    try {
      workspace = await findLaneWorkspace(client, config, lane, workspaces);
      if (!workspace) throw new Error("no workspace found");
      const provider = config.providers[action.provider];
      const session = await client.createSession({
        workspaceId: workspace.id,
        name: `${lane.id} recovery`,
        agent: provider.agent,
        model: provider.model,
        effort: provider.effort,
      });
      await client.sendMessage({
        sessionId: session.id,
        message:
          "Continue the lane in this same workspace. Inspect the existing branch and prior work, finish the task, and end with the PR URL.",
        messageId: randomUUID(),
      });
      observeLaneSession({
        sessionId: session.id,
        laneId: lane.id,
        role: "author",
        lastAssistantAt: null,
      });
      recordLaneAction({
        laneId: lane.id,
        provider: action.provider,
        action: "restart",
        detail: `${workspace.id}:${session.id}`,
      });
      return {
        ok: true,
        notice: `restarted ${lane.id} in workspace ${workspace.id}`,
        assignedProvider: action.provider,
      };
    } catch (error) {
      const notice = `restart ${lane.id} failed: ${describeError(error)}`;
      recordLaneAction({
        laneId: lane.id,
        provider: action.provider,
        action: "restart_failed",
        detail: describeError(error),
      });
      return { ok: false, notice };
    }
  }
  if (action.type === "nudge") {
    return sendLaneMessage({
      client,
      config,
      lane,
      action,
      workspaces,
      message: LANE_NUDGE_MESSAGE,
      successKind: "nudge",
      failureKind: "nudge_failed",
      successNotice: `nudged ${lane.id} (${action.provider})`,
    });
  }

  if (action.type === "prompt") {
    try {
      const prompt = readLanePrompt(config, lane);
      return await sendLaneMessage({
        client,
        config,
        lane,
        action,
        workspaces,
        message: prompt,
        successKind: "prompt",
        failureKind: "prompt_failed",
        successNotice: `prompted ${lane.id} (${action.provider})`,
      });
    } catch (error) {
      const notice = `prompt ${lane.id} failed: ${describeError(error)}`;
      log.error(notice);
      recordLaneAction({
        laneId: lane.id,
        provider: action.provider,
        action: "prompt_failed",
        detail: describeError(error),
      });
      return { ok: false, notice };
    }
  }

  let existing: ConductorApiWorkspace | null;
  try {
    existing = await findLaneWorkspace(client, config, lane, workspaces);
  } catch (error) {
    const notice = `create ${lane.id} skipped: ${describeError(error)}`;
    log.error(notice);
    recordLaneAction({
      laneId: lane.id,
      provider: action.provider,
      action: "create_failed",
      detail: describeError(error),
    });
    return { ok: false, notice };
  }

  if (existing) {
    const notice = `create ${lane.id} refused: workspace already exists`;
    log.warn(notice);
    recordLaneAction({
      laneId: lane.id,
      provider: action.provider,
      action: "create_refused",
      detail: existing.id,
    });
    return { ok: false, notice };
  }

  const provider = config.providers[action.provider];
  const name = laneWorkspaceName(lane.id, action.provider, lane.title);
  let created: { workspaceId: string; sessionId: string };
  try {
    created = lane.projectId
      ? await client.createWorkspace({
          projectId: lane.projectId,
          name,
          agent: provider.agent,
          model: provider.model,
          effort: provider.effort,
        })
      : await client.createWorkspace({
          repositoryUrl: lane.repoUrl,
          name,
          agent: provider.agent,
          model: provider.model,
          effort: provider.effort,
        });
  } catch (error) {
    const notice = `create ${lane.id} failed: ${describeError(error)}`;
    log.error(notice);
    recordLaneAction({
      laneId: lane.id,
      provider: action.provider,
      action: "create_failed",
      detail: describeError(error),
    });
    return { ok: false, notice };
  }

  try {
    const prompt = readLanePrompt(config, lane);
    await client.sendMessage({
      sessionId: created.sessionId,
      message: prompt,
      messageId: randomUUID(),
    });
  } catch (error) {
    const notice = `create ${lane.id} workspace ${created.workspaceId} needs its first prompt: ${describeError(error)}`;
    log.error(notice);
    recordLaneAction({
      laneId: lane.id,
      provider: action.provider,
      action: "create_failed",
      detail: `${created.workspaceId}: ${describeError(error)}`,
    });
    return {
      ok: false,
      notice,
      assignedProvider: action.provider,
    };
  }

  recordLaneAction({
    laneId: lane.id,
    provider: action.provider,
    action: "create",
    detail: created.workspaceId,
  });
  return {
    ok: true,
    notice: `created ${lane.id} (${action.provider})`,
    assignedProvider: action.provider,
  };
}

async function sendLaneMessage(input: {
  client: ConductorApiClient;
  config: LanesConfig;
  lane: LaneConfig;
  action: LaneAction;
  workspaces: ConductorApiWorkspace[];
  message: string;
  successKind: "nudge" | "prompt";
  failureKind: "nudge_failed" | "prompt_failed";
  successNotice: string;
}): Promise<ExecuteOutcome> {
  try {
    const sessionId = await resolveLaneSessionId(
      input.client,
      input.config,
      input.lane,
      input.workspaces
    );
    if (!sessionId) {
      const notice = `${input.successKind} ${input.lane.id}: no session found`;
      log.warn(notice);
      recordLaneAction({
        laneId: input.lane.id,
        provider: input.action.provider,
        action: input.failureKind,
        detail: notice,
      });
      return { ok: false, notice };
    }
    await input.client.sendMessage({
      sessionId,
      message: input.message,
      messageId: randomUUID(),
    });
    if (input.successKind === "nudge") {
      recordLaneSessionNudge(sessionId);
    }
    recordLaneAction({
      laneId: input.lane.id,
      provider: input.action.provider,
      action: input.successKind,
      detail: sessionId,
    });
    return {
      ok: true,
      notice: input.successNotice,
      assignedProvider: input.action.provider,
    };
  } catch (error) {
    const notice = `${input.successKind} ${input.lane.id} failed: ${describeError(error)}`;
    log.error(notice);
    recordLaneAction({
      laneId: input.lane.id,
      provider: input.action.provider,
      action: input.failureKind,
      detail: describeError(error),
    });
    return { ok: false, notice };
  }
}

async function notifyAction(
  notify: LanesNotify,
  action: LaneAction,
  outcome: ExecuteOutcome
): Promise<void> {
  try {
    await notify(`🚦 ${outcome.notice}`);
  } catch (error) {
    log.warn(`owner notice failed for ${action.laneId}:`, error);
  }
}

function applyLocalSnapshotUpdate(
  snapshots: LaneSnapshot[],
  action: LaneAction,
  outcome: ExecuteOutcome
): void {
  const snapshot = snapshots.find((entry) => entry.id === action.laneId);
  if (!snapshot || !outcome.ok) return;
  snapshot.assignedProvider = outcome.assignedProvider ?? action.provider;
  snapshot.lastUserMessageAt = new Date().toISOString();
  snapshot.lastActionKind = action.type;
  if (action.type === "nudge") {
    snapshot.state = "working";
    snapshot.nudgeCount += 1;
  } else if (action.type !== "restart") {
    snapshot.state = "paused";
  } else {
    snapshot.state = "working";
    snapshot.unansweredNudges = 0;
  }
}

async function resolveLaneSnapshots(
  client: ConductorApiClient,
  config: LanesConfig,
  workspaces: ConductorApiWorkspace[]
): Promise<LaneSnapshot[]> {
  const lastActions = getLatestLaneActions(config.lanes.map((lane) => lane.id));
  const snapshots: LaneSnapshot[] = [];
  for (const lane of config.lanes) {
    try {
      snapshots.push(
        await snapshotLane(client, config, lane, workspaces, lastActions.get(lane.id))
      );
    } catch (error) {
      log.error(`could not resolve lane ${lane.id}:`, error);
      snapshots.push(
        unknownLaneSnapshot(lane, lastActions.get(lane.id))
      );
    }
  }
  return snapshots;
}

async function snapshotLane(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  workspaces: ConductorApiWorkspace[],
  lastAction: LaneActionRecord | undefined
): Promise<LaneSnapshot> {
  const fallbackProvider =
    lastAction?.provider ?? (lane.provider === "any" ? null : lane.provider);
  const workspace = await findLaneWorkspace(client, config, lane, workspaces);
  const nudgeCount = countLaneActions(lane.id, "nudge");
  const promptFailedCount = countLaneActions(lane.id, "prompt_failed");
  if (!workspace) {
    return {
      id: lane.id,
      provider: lane.provider,
      assignedProvider: lane.provider === "any" ? null : lane.provider,
      state: "not_created",
      lastUserMessageAt: null,
      after: lane.after,
      nudgeCount,
      promptFailedCount,
      lastActionKind: lastAction?.action ?? null,
      workspaceId: null,
      sessionId: null,
      prUrl: null,
      lastAssistantAt: null,
      unansweredNudges: 0,
      rateLimitUntil: null,
    };
  }

  const parsed = parseLaneWorkspaceName(workspace.name);
  const assignedProvider = parsed?.provider ?? fallbackProvider;

  let sessionId: string | null;
  try {
    sessionId = await resolveLaneSessionId(
      client,
      config,
      lane,
      workspaces,
      workspace.id
    );
  } catch (error) {
    log.warn(`list sessions for ${lane.id} failed:`, error);
    return unknownLaneSnapshot(lane, lastAction, assignedProvider);
  }
  if (!sessionId) {
    return {
      id: lane.id,
      provider: lane.provider,
      assignedProvider,
      state: "initializing",
      lastUserMessageAt: null,
      after: lane.after,
      nudgeCount,
      promptFailedCount,
      lastActionKind: lastAction?.action ?? null,
      workspaceId: workspace.id,
      sessionId: null,
      prUrl: null,
      lastAssistantAt: null,
      unansweredNudges: 0,
      rateLimitUntil: null,
    };
  }

  let sessionStatus: "idle" | "working" | "error" | null = null;
  let statusUnknown = false;
  try {
    sessionStatus = (await client.getSessionStatus(sessionId)).status;
  } catch (error) {
    statusUnknown = true;
    log.warn(`session status for ${lane.id} failed:`, error);
  }

  let messages: ConductorApiMessage[];
  try {
    messages = await listAllSessionMessages(client, sessionId);
  } catch (error) {
    log.warn(`transcript for ${lane.id} failed:`, error);
    if (!statusUnknown && sessionStatus === "working") {
      return {
        id: lane.id,
        provider: lane.provider,
        assignedProvider,
        state: "working",
        lastUserMessageAt: null,
        after: lane.after,
        nudgeCount,
        promptFailedCount,
        lastActionKind: lastAction?.action ?? null,
      };
    }
    return unknownLaneSnapshot(lane, lastAction, assignedProvider);
  }

  const derived = deriveLaneRuntimeState({
    workspaceFound: true,
    sessionStatus,
    statusUnknown,
    messages: messages.map((message) => ({
      type: message.type,
      content: message.content,
      receivedAt: message.receivedAt,
    })),
  });
  const assistantMessages = messages.filter(
    (message) => assistantTextFromTranscriptEvent(message).trim().length > 0
  );
  const lastAssistant = assistantMessages.at(-1);
  const lastAssistantText = lastAssistant
    ? assistantTextFromTranscriptEvent(lastAssistant)
    : "";
  const rateLimitUntil = parseRateLimitReset(
    assistantMessages
      .map((message) => assistantTextFromTranscriptEvent(message))
      .join("\n")
  );
  if (rateLimitUntil && assignedProvider) {
    setLaneProviderOutage(assignedProvider, rateLimitUntil);
  }
  const health = observeLaneSession({
    sessionId,
    laneId: lane.id,
    role: "author",
    lastAssistantAt: lastAssistant?.receivedAt ?? null,
    rateLimitUntil,
  });
  return {
    id: lane.id,
    provider: lane.provider,
    assignedProvider,
    ...derived,
    after: lane.after,
    nudgeCount,
    promptFailedCount,
    lastActionKind: lastAction?.action ?? null,
    workspaceId: workspace.id,
    sessionId,
    prUrl: githubPrUrlFromText(lastAssistantText),
    lastAssistantAt: lastAssistant?.receivedAt ?? null,
    unansweredNudges: health.unansweredNudges,
    rateLimitUntil: health.rateLimitUntil,
  };
}

async function findLaneWorkspace(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  index: ConductorApiWorkspace[]
): Promise<ConductorApiWorkspace | null> {
  if (lane.workspaceId) {
    try {
      return await client.getWorkspace(lane.workspaceId);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw new LaneWorkspaceIndexError(
          `could not load workspace ${lane.workspaceId} for lane ${lane.id}`,
          { cause: error }
        );
      }
    }
  }

  if (lane.sessionId) {
    try {
      const status = await client.getSessionStatus(lane.sessionId);
      return await client.getWorkspace(status.workspaceId);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw new LaneWorkspaceIndexError(
          `could not load session ${lane.sessionId} for lane ${lane.id}`,
          { cause: error }
        );
      }
    }
  }

  const prefix = laneWorkspaceNamePrefix(lane.id);
  const matches = workspacesMatchingPrefix(index, prefix);
  if (matches.length === 0) return null;
  return matches.sort((a, b) =>
    (b.lastActivityAt ?? b.createdAt).localeCompare(
      a.lastActivityAt ?? a.createdAt
    )
  )[0];
}

async function resolveLaneSessionId(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  workspaces: ConductorApiWorkspace[],
  workspaceId?: string
): Promise<string | null> {
  if (lane.sessionId) return lane.sessionId;
  const id =
    workspaceId ?? (await findLaneWorkspace(client, config, lane, workspaces))?.id;
  if (!id) return null;
  try {
    const sessions = await client.listWorkspaceSessions(id, {
      includeArchived: true,
    });
    const sorted = sessions
      .map((session, index) => ({ session, index }))
      .sort((a, b) => {
        const byDate = (b.session.createdAt ?? "").localeCompare(
          a.session.createdAt ?? ""
        );
        return byDate || a.index - b.index;
      });
    return sorted[0]?.session.id ?? null;
  } catch (error) {
    throw new LaneWorkspaceIndexError(
      `could not list sessions for lane ${lane.id}`,
      { cause: error }
    );
  }
}

/**
 * Per-lane name-filtered listing. Throws when existence cannot be
 * established, so a tick never treats a listing outage as "not created".
 *
 * @internal exported for scheduler unit tests.
 */
export async function loadWorkspaceIndex(
  client: ConductorApiClient,
  config: LanesConfig
): Promise<ConductorApiWorkspace[]> {
  const found = new Map<string, ConductorApiWorkspace>();
  const unresolved = new Set<string>();
  const errors: string[] = [];

  for (const lane of config.lanes) {
    const prefix = laneWorkspaceNamePrefix(lane.id);
    try {
      const listed = await client.listWorkspaces({
        mine: true,
        name: prefix,
        includeArchived: true,
      });
      for (const workspace of listed) found.set(workspace.id, workspace);
    } catch (error) {
      errors.push(`${lane.id}: ${describeError(error)}`);
      unresolved.add(lane.id);
    }
  }

  if (unresolved.size === 0) {
    return [...found.values()];
  }

  try {
    const fallback = await loadProjectWorkspaceFallback(
      client,
      config,
      unresolved
    );
    for (const workspace of fallback) found.set(workspace.id, workspace);
  } catch (error) {
    throw new LaneWorkspaceIndexError(
      `could not list lane workspaces (${[...errors, describeError(error)].join("; ") || "unknown error"})`,
      { cause: error }
    );
  }

  return [...found.values()];
}

async function loadProjectWorkspaceFallback(
  client: ConductorApiClient,
  config: LanesConfig,
  unresolvedLaneIds: ReadonlySet<string>
): Promise<ConductorApiWorkspace[]> {
  const unresolvedLanes = config.lanes.filter((lane) =>
    unresolvedLaneIds.has(lane.id)
  );
  const found: ConductorApiWorkspace[] = [];
  const seen = new Set<string>();

  let projects: Awaited<ReturnType<ConductorApiClient["listProjects"]>>;
  try {
    projects = await client.listProjects();
  } catch (error) {
    throw new LaneWorkspaceIndexError(
      `per-project workspace listing failed: ${describeError(error)}`,
      { cause: error }
    );
  }

  const neededProjectIds = new Set<string>();
  const unmapped: string[] = [];
  for (const lane of unresolvedLanes) {
    const candidates = projectsForLane(lane, projects);
    if (candidates.length === 0) {
      unmapped.push(lane.id);
      continue;
    }
    for (const id of candidates) neededProjectIds.add(id);
  }
  if (unmapped.length > 0) {
    throw new LaneWorkspaceIndexError(
      `could not prove workspace absence for lane(s) ${unmapped.join(", ")}: no matching Cloud project`
    );
  }

  const listedProjects = new Set<string>();
  const listErrors: string[] = [];
  for (const projectId of neededProjectIds) {
    try {
      const workspaces = await client.listProjectWorkspaces(projectId);
      listedProjects.add(projectId);
      for (const workspace of workspaces) {
        if (seen.has(workspace.id)) continue;
        seen.add(workspace.id);
        found.push(workspace);
      }
    } catch (error) {
      listErrors.push(`${projectId}: ${describeError(error)}`);
    }
  }

  if (listErrors.length > 0) {
    throw new LaneWorkspaceIndexError(
      `per-project workspace listing failed (${listErrors.join("; ")})`
    );
  }

  for (const lane of unresolvedLanes) {
    const missing = projectsForLane(lane, projects).filter(
      (id) => !listedProjects.has(id)
    );
    if (missing.length > 0) {
      throw new LaneWorkspaceIndexError(
        `could not list projects for lane ${lane.id} (${missing.join(", ")})`
      );
    }
  }

  return found;
}

function projectsForLane(
  lane: LaneConfig,
  projects: ReadonlyArray<{ id: string; gitRemote: string }>
): string[] {
  const ids = new Set<string>();
  if (lane.projectId) ids.add(lane.projectId);
  const laneRemote = normalizeRemote(lane.repoUrl);
  for (const project of projects) {
    if (normalizeRemote(project.gitRemote) === laneRemote) {
      ids.add(project.id);
    }
  }
  return [...ids];
}

function unknownLaneSnapshot(
  lane: LaneConfig,
  lastAction: LaneActionRecord | undefined,
  assignedProvider?: string | null
): LaneSnapshot {
  return {
    id: lane.id,
    provider: lane.provider,
    assignedProvider:
      assignedProvider ??
      lastAction?.provider ??
      (lane.provider === "any" ? null : lane.provider),
    state: "unknown",
    lastUserMessageAt: null,
    after: lane.after,
    nudgeCount: countLaneActions(lane.id, "nudge"),
    promptFailedCount: countLaneActions(lane.id, "prompt_failed"),
    lastActionKind: lastAction?.action ?? null,
  };
}

function workspacesMatchingPrefix(
  workspaces: ConductorApiWorkspace[],
  prefix: string
): ConductorApiWorkspace[] {
  return workspaces.filter((workspace) => {
    if (!workspace.name.includes(prefix)) return false;
    if (workspace.name.toLowerCase().includes("[abandoned")) return false;
    return parseLaneWorkspaceName(workspace.name) !== null;
  });
}

async function listAllSessionMessages(
  client: ConductorApiClient,
  sessionId: string
): Promise<ConductorApiMessage[]> {
  const all: ConductorApiMessage[] = [];
  let after: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const batch = await client.listSessionMessages({
      sessionId,
      after,
      limit: 100,
    });
    if (batch.length === 0) break;
    all.push(...batch);
    after = batch[batch.length - 1].id;
    if (batch.length < 100) break;
  }
  return all;
}

function readLanePrompt(config: LanesConfig, lane: LaneConfig): string {
  const promptPath = path.isAbsolute(lane.prompt)
    ? lane.prompt
    : path.join(path.dirname(config.configPath), lane.prompt);
  return readFileSync(promptPath, "utf8");
}

function statusRows(
  config: LanesConfig,
  snapshots: LaneSnapshot[],
  lastActions: Map<string, LaneActionRecord>
): LaneStatusRow[] {
  const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  return config.lanes.map((lane) => {
    const snapshot = byId.get(lane.id);
    return {
      id: lane.id,
      title: lane.title,
      provider: lane.provider,
      assignedProvider: snapshot?.assignedProvider ?? null,
      state: snapshot?.state ?? "not_created",
      lastAction: lastActions.get(lane.id) ?? null,
      deliveryStage: getLaneStageView(lane),
    };
  });
}

function normalizeRemote(value: string): string {
  let remote = value.trim();
  if (!remote.includes("://")) {
    const scp = remote.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) {
      remote = `${scp[1]}/${scp[2]}`;
    }
  } else {
    remote = remote.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    remote = remote.replace(/^[^@/\s]+@/, "");
  }
  return remote.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof ConductorApiError && error.status === 404;
}

function logInvalidConfig(message: string): void {
  const now = Date.now();
  if (
    message === lastInvalidConfigLog.message &&
    now - lastInvalidConfigLog.at < INVALID_CONFIG_LOG_MS
  ) {
    return;
  }
  lastInvalidConfigLog = { message, at: now };
  log.error(message);
}

function describeError(error: unknown): string {
  if (error instanceof ConductorApiError) return error.message;
  return String((error as Error)?.message ?? error);
}
