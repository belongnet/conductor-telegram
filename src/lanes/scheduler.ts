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
  getLanesLastTickAt,
  getLatestLaneActions,
  isLanesPaused,
  recordLaneAction,
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
  decideLaneActions,
  deriveLaneRuntimeState,
  laneWorkspaceName,
  laneWorkspaceNamePrefix,
  parseLaneWorkspaceName,
  type LaneAction,
  type LaneRuntimeState,
  type LaneSnapshot,
} from "./decide.js";

const log = createLogger("lanes");
const DUE_CHECK_MS = 60_000;

export type LaneStatusRow = {
  id: string;
  title: string;
  provider: string;
  assignedProvider: string | null;
  state: LaneRuntimeState;
  lastAction: LaneActionRecord | null;
};

export type LanesTickResult = {
  skipped: boolean;
  reason?: string;
  actions: LaneAction[];
  statuses: LaneStatusRow[];
};

export type LanesNotify = (text: string) => Promise<void>;

let tickInFlight = false;

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
    log.error(message);
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
      // Start the interval clock on first boot without launching work.
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

  const snapshots = await resolveLaneSnapshots(client, config);
  const lastActions = getLatestLaneActions(config.lanes.map((lane) => lane.id));
  const statuses = statusRows(config, snapshots, lastActions);

  if (paused && !options.force) {
    setLanesLastTickAt(new Date().toISOString());
    return {
      skipped: true,
      reason: "Lanes scheduler is paused.",
      actions: [],
      statuses,
    };
  }
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

    const outcome = await executeLaneAction(client, config, lane, action);
    if (outcome.ok) {
      succeededProviders.add(action.provider);
      executed.push(action);
      applyLocalSnapshotUpdate(snapshots, action, outcome);
    } else {
      failedLaneIds.add(action.laneId);
    }

    await notifyAction(options.notify, action, outcome);
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
    const snapshots = await resolveLaneSnapshots(client, config);
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

type ExecuteOutcome = {
  ok: boolean;
  notice: string;
  assignedProvider?: string;
};

async function executeLaneAction(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  action: LaneAction
): Promise<ExecuteOutcome> {
  if (action.type === "nudge") {
    try {
      const sessionId = await resolveLaneSessionId(client, config, lane);
      if (!sessionId) {
        const notice = `nudge ${lane.id}: no session found`;
        log.warn(notice);
        recordLaneAction({
          laneId: lane.id,
          provider: action.provider,
          action: "nudge_failed",
          detail: notice,
        });
        return { ok: false, notice };
      }
      await client.sendMessage({
        sessionId,
        message: LANE_NUDGE_MESSAGE,
        messageId: randomUUID(),
      });
      recordLaneAction({
        laneId: lane.id,
        provider: action.provider,
        action: "nudge",
        detail: sessionId,
      });
      return { ok: true, notice: `nudged ${lane.id} (${action.provider})` };
    } catch (error) {
      const notice = `nudge ${lane.id} failed: ${describeError(error)}`;
      log.error(notice);
      recordLaneAction({
        laneId: lane.id,
        provider: action.provider,
        action: "nudge_failed",
        detail: describeError(error),
      });
      return { ok: false, notice };
    }
  }

  try {
    const existing = await findLaneWorkspace(client, config, lane);
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

    const prompt = readLanePrompt(config, lane);
    const provider = config.providers[action.provider];
    const name = laneWorkspaceName(lane.id, action.provider, lane.title);
    const created = lane.projectId
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
    await client.sendMessage({
      sessionId: created.sessionId,
      message: prompt,
      messageId: randomUUID(),
    });
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
  if (action.type === "create") {
    snapshot.state = "initializing";
    snapshot.assignedProvider = outcome.assignedProvider ?? action.provider;
    snapshot.lastUserMessageAt = new Date().toISOString();
    // After the prompt is sent there is a user message, so the lane is
    // no longer initializing — treat it as paused until the next poll.
    snapshot.state = "paused";
  } else {
    snapshot.state = "working";
    snapshot.lastUserMessageAt = new Date().toISOString();
  }
}

async function resolveLaneSnapshots(
  client: ConductorApiClient,
  config: LanesConfig
): Promise<LaneSnapshot[]> {
  const workspaces = await loadWorkspaceIndex(client, config);
  const snapshots: LaneSnapshot[] = [];
  for (const lane of config.lanes) {
    try {
      snapshots.push(await snapshotLane(client, config, lane, workspaces));
    } catch (error) {
      log.error(`could not resolve lane ${lane.id}:`, error);
      snapshots.push({
        id: lane.id,
        provider: lane.provider,
        assignedProvider: lane.provider === "any" ? null : lane.provider,
        state: "not_created",
        lastUserMessageAt: null,
        after: lane.after,
      });
    }
  }
  return snapshots;
}

async function snapshotLane(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  workspaces: ConductorApiWorkspace[]
): Promise<LaneSnapshot> {
  const workspace = await findLaneWorkspace(client, config, lane, workspaces);
  if (!workspace) {
    return {
      id: lane.id,
      provider: lane.provider,
      assignedProvider: lane.provider === "any" ? null : lane.provider,
      state: "not_created",
      lastUserMessageAt: null,
      after: lane.after,
    };
  }

  const parsed = parseLaneWorkspaceName(workspace.name);
  const assignedProvider =
    parsed?.provider ??
    (lane.provider === "any" ? null : lane.provider);

  const sessionId = await resolveLaneSessionId(
    client,
    config,
    lane,
    workspace.id
  );
  if (!sessionId) {
    return {
      id: lane.id,
      provider: lane.provider,
      assignedProvider,
      state: "initializing",
      lastUserMessageAt: null,
      after: lane.after,
    };
  }

  let sessionStatus: "idle" | "working" | "error" | null = null;
  try {
    sessionStatus = (await client.getSessionStatus(sessionId)).status;
  } catch (error) {
    log.warn(`session status for ${lane.id} failed:`, error);
  }

  const messages = await listAllSessionMessages(client, sessionId);
  const derived = deriveLaneRuntimeState({
    workspaceFound: true,
    sessionStatus,
    messages: messages.map((message) => ({
      type: message.type,
      content: message.content,
      receivedAt: message.receivedAt,
    })),
  });
  return {
    id: lane.id,
    provider: lane.provider,
    assignedProvider,
    ...derived,
    after: lane.after,
  };
}

async function findLaneWorkspace(
  client: ConductorApiClient,
  config: LanesConfig,
  lane: LaneConfig,
  index?: ConductorApiWorkspace[]
): Promise<ConductorApiWorkspace | null> {
  if (lane.workspaceId) {
    try {
      return await client.getWorkspace(lane.workspaceId);
    } catch (error) {
      log.warn(`getWorkspace ${lane.workspaceId} failed:`, error);
    }
  }

  if (lane.sessionId) {
    try {
      const status = await client.getSessionStatus(lane.sessionId);
      return await client.getWorkspace(status.workspaceId);
    } catch (error) {
      log.warn(`session ${lane.sessionId} lookup failed:`, error);
    }
  }

  const prefix = laneWorkspaceNamePrefix(lane.id);
  const pool = index ?? (await loadWorkspaceIndex(client, config));
  const matches = workspacesMatchingPrefix(pool, prefix);
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
  workspaceId?: string
): Promise<string | null> {
  if (lane.sessionId) return lane.sessionId;
  const id =
    workspaceId ?? (await findLaneWorkspace(client, config, lane))?.id;
  if (!id) return null;
  try {
    const sessions = await client.listWorkspaceSessions(id);
    const live = sessions.filter((session) => !session.archivedAt);
    return (live[0] ?? sessions[0])?.id ?? null;
  } catch (error) {
    log.warn(`list sessions for ${lane.id} failed:`, error);
    return null;
  }
}

async function loadWorkspaceIndex(
  client: ConductorApiClient,
  config: LanesConfig
): Promise<ConductorApiWorkspace[]> {
  try {
    const listed = await client.listWorkspaces({ mine: true });
    if (listed.length > 0) return listed;
    // An empty mine listing can still be correct; also try unfiltered and
    // keep both so a name-prefix match cannot miss an existing workspace.
    const all = await client.listWorkspaces();
    return all.length > 0 ? all : listed;
  } catch (error) {
    log.warn(
      "listWorkspaces failed; falling back to per-project listing:",
      error
    );
  }

  const found: ConductorApiWorkspace[] = [];
  const seen = new Set<string>();
  const projectIds = new Set(
    config.lanes.map((lane) => lane.projectId).filter((id): id is string => Boolean(id))
  );

  let projects: Awaited<ReturnType<ConductorApiClient["listProjects"]>> = [];
  try {
    projects = await client.listProjects();
  } catch (error) {
    log.warn("listProjects fallback failed:", error);
  }

  for (const project of projects) {
    const wanted =
      projectIds.has(project.id) ||
      config.lanes.some(
        (lane) =>
          normalizeRemote(lane.repoUrl) === normalizeRemote(project.gitRemote)
      );
    if (!wanted) continue;
    try {
      const workspaces = await client.listProjectWorkspaces(project.id);
      for (const workspace of workspaces) {
        if (seen.has(workspace.id)) continue;
        seen.add(workspace.id);
        found.push(workspace);
      }
    } catch (error) {
      log.warn(`listProjectWorkspaces ${project.id} failed:`, error);
    }
  }
  return found;
}

function workspacesMatchingPrefix(
  workspaces: ConductorApiWorkspace[],
  prefix: string
): ConductorApiWorkspace[] {
  return workspaces.filter((workspace) => workspace.name.startsWith(prefix));
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
    };
  });
}

function normalizeRemote(value: string): string {
  return value
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function describeError(error: unknown): string {
  if (error instanceof ConductorApiError) return error.message;
  return String((error as Error)?.message ?? error);
}
