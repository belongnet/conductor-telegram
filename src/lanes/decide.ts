export const LANE_NUDGE_MESSAGE =
  "Continue where you left off; end with the PR URL.";

export const GITHUB_PR_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;

const HIDDEN_ITEM_TYPE_RE = /tool|command|function|mcp|reasoning|thinking/;
const VISIBLE_ASSISTANT_ITEM_TYPES = new Set([
  "text",
  "agentmessage",
  "message",
  "outputtext",
]);

export type LaneRuntimeState =
  | "working"
  | "done"
  | "paused"
  | "initializing"
  | "not_created"
  | "unknown";

export type LaneSnapshot = {
  id: string;
  /** Configured provider, or `"any"`. */
  provider: string;
  /**
   * Provider currently occupying this lane. Named lanes use their config
   * provider once created; `"any"` lanes use the provider recorded in the
   * workspace name or last recorded action.
   */
  assignedProvider: string | null;
  state: LaneRuntimeState;
  lastUserMessageAt: string | null;
  after: string[];
  nudgeCount: number;
  promptFailedCount: number;
  /** Last recorded SQLite action, used to gate first-prompt retries. */
  lastActionKind: string | null;
};

export type ProviderLimits = {
  name: string;
  gapHours: number;
  maxActive: number;
  maxNudges?: number;
};

export type LaneAction =
  | { type: "nudge"; laneId: string; provider: string }
  | { type: "prompt"; laneId: string; provider: string }
  | { type: "create"; laneId: string; provider: string };

export type DecideLaneActionsInput = {
  now: Date;
  paused: boolean;
  providers: readonly ProviderLimits[];
  lanes: readonly LaneSnapshot[];
  /** Lanes whose create/nudge already failed this tick; skipped so the queue can move on. */
  failedLaneIds?: ReadonlySet<string>;
};

export function laneWorkspaceNamePrefix(laneId: string): string {
  return `[lane:${laneId}:`;
}

export function laneWorkspaceName(
  laneId: string,
  provider: string,
  title: string
): string {
  return `[lane:${laneId}:${provider}] ${title}`;
}

export function parseLaneWorkspaceName(
  name: string
): { laneId: string; provider: string } | null {
  const match = name.match(/^\[lane:([^:\]]+):([^\]]+)\]/);
  if (!match) return null;
  return { laneId: match[1], provider: match[2] };
}

export function transcriptContainsGithubPrUrl(text: string): boolean {
  return GITHUB_PR_URL_RE.test(text);
}

export function isUserTranscriptEvent(message: {
  type: string;
  content?: unknown;
}): boolean {
  return transcriptRole(message) === "user";
}

export function isAgentTranscriptEvent(message: {
  type: string;
  content?: unknown;
}): boolean {
  return transcriptRole(message) === "assistant";
}

/**
 * Assistant-visible text only. Tool/command payloads and non-visible
 * lifecycle items such as `reasoning` / `thinking` are ignored so a
 * review lane cannot mark itself done from an internal thought that
 * mentions a pull request.
 */
export function assistantTextFromTranscriptEvent(message: {
  type: string;
  content?: unknown;
}): string {
  if (!isAgentTranscriptEvent(message)) return "";
  if (isHiddenItemType(message.type)) return "";
  if (typeof message.content === "string") return message.content;
  const blocks: string[] = [];
  collectAssistantText(message.content, blocks, 0);
  return blocks.join("\n");
}

function collectAssistantText(
  value: unknown,
  blocks: string[],
  depth: number
): void {
  if (depth > 10 || value == null) return;
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const entry of value) collectAssistantText(entry, blocks, depth + 1);
    return;
  }
  if (typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (isUserRoleObject(obj)) return;
  const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
  if (isHiddenItemType(type)) return;

  if (obj.item && typeof obj.item === "object" && !Array.isArray(obj.item)) {
    const item = obj.item as Record<string, unknown>;
    if (isUserRoleObject(item)) return;
    const itemType = typeof item.type === "string" ? item.type.toLowerCase() : "";
    if (!isVisibleAssistantItemType(itemType)) return;
    pushTextField(item, blocks);
    collectAssistantText(item.content, blocks, depth + 1);
    return;
  }

  pushTextField(obj, blocks);
  if (obj.message) collectAssistantText(obj.message, blocks, depth + 1);
  if (obj.content && typeof obj.content !== "string") {
    collectAssistantText(obj.content, blocks, depth + 1);
  }
  if (obj.rawPayload) collectAssistantText(obj.rawPayload, blocks, depth + 1);
  if (obj.event) collectAssistantText(obj.event, blocks, depth + 1);
}

function pushTextField(obj: Record<string, unknown>, blocks: string[]): void {
  if (isUserRoleObject(obj)) return;
  const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
  if (!isVisibleAssistantItemType(type)) return;
  if (typeof obj.text === "string" && obj.text.trim()) {
    blocks.push(obj.text);
  }
  if (typeof obj.content === "string" && obj.content.trim()) {
    blocks.push(obj.content);
  }
}

function normalizeItemType(type: string): string {
  return type.toLowerCase().replace(/[_-]/g, "");
}

function isHiddenItemType(type: string): boolean {
  if (!type) return false;
  return HIDDEN_ITEM_TYPE_RE.test(normalizeItemType(type));
}

function isVisibleAssistantItemType(type: string): boolean {
  if (!type) return true;
  const normalized = normalizeItemType(type);
  if (isHiddenItemType(normalized)) return false;
  return VISIBLE_ASSISTANT_ITEM_TYPES.has(normalized);
}

function isUserRoleObject(obj: Record<string, unknown>): boolean {
  const role = typeof obj.role === "string" ? normalizeItemType(obj.role) : "";
  const type = typeof obj.type === "string" ? normalizeItemType(obj.type) : "";
  return (
    role === "user" ||
    role === "human" ||
    type === "user" ||
    type === "human" ||
    type === "usermessage"
  );
}

function transcriptRole(message: {
  type: string;
  content?: unknown;
}): "user" | "assistant" | "other" {
  const content =
    message.content && typeof message.content === "object"
      ? (message.content as Record<string, unknown>)
      : null;
  const nested =
    content?.message && typeof content.message === "object"
      ? (content.message as Record<string, unknown>)
      : null;
  const candidates = [content?.role, nested?.role, content?.type, message.type]
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.toLowerCase());
  if (
    candidates.some(
      (candidate) =>
        candidate === "assistant" ||
        candidate.includes("assistant") ||
        candidate.includes("agent") ||
        candidate.includes("result")
    )
  ) {
    return "assistant";
  }
  if (
    candidates.some(
      (candidate) =>
        candidate === "user" ||
        candidate.includes("user") ||
        candidate.includes("human")
    )
  ) {
    return "user";
  }
  return "other";
}

export function deriveLaneRuntimeState(input: {
  workspaceFound: boolean;
  sessionStatus: "idle" | "working" | "error" | null;
  statusUnknown?: boolean;
  messages: ReadonlyArray<{ type: string; content?: unknown; receivedAt: string }>;
}): {
  state: LaneRuntimeState;
  lastUserMessageAt: string | null;
} {
  if (!input.workspaceFound) {
    return { state: "not_created", lastUserMessageAt: null };
  }

  const userEvents = input.messages.filter(isUserTranscriptEvent);
  const lastUserMessageAt =
    userEvents.length > 0
      ? userEvents[userEvents.length - 1].receivedAt
      : null;

  // A live turn is working even with an empty or unread transcript. Checking
  // this before the zero-user-message branch prevents a failed/empty
  // transcript fetch from re-sending the full lane prompt mid-turn.
  if (input.sessionStatus === "working") {
    return { state: "working", lastUserMessageAt };
  }

  if (input.statusUnknown) {
    return { state: "unknown", lastUserMessageAt };
  }

  if (userEvents.length === 0) {
    return { state: "initializing", lastUserMessageAt: null };
  }

  // Only the assistant text of the turn after the last user message — an
  // idle session's final reply — can mark the lane done.
  const lastUserIndex = input.messages.reduce(
    (index, message, current) =>
      isUserTranscriptEvent(message) ? current : index,
    -1
  );
  const lastTurn = input.messages.slice(lastUserIndex + 1);
  const lastAgentWithText = [...lastTurn]
    .reverse()
    .find(
      (message) =>
        isAgentTranscriptEvent(message) &&
        assistantTextFromTranscriptEvent(message).trim()
    );
  const done =
    lastAgentWithText !== undefined &&
    transcriptContainsGithubPrUrl(
      assistantTextFromTranscriptEvent(lastAgentWithText)
    );
  if (done) {
    return { state: "done", lastUserMessageAt };
  }

  return { state: "paused", lastUserMessageAt };
}

/**
 * Pure scheduler: at most one action per provider whose working count is
 * below `maxActive`. Unknown snapshots occupy a slot the same way working
 * ones do, so a status or listing outage cannot start another paid lane.
 * Nudge the first eligible paused lane; otherwise retry the first prompt of
 * an initializing lane whose last recorded action is a failed first send;
 * otherwise create the first not-created lane for that provider (or
 * `"any"`). Failed lanes are skipped so the queue can advance.
 */
export function decideLaneActions(input: DecideLaneActionsInput): LaneAction[] {
  if (input.paused) return [];

  const failed = input.failedLaneIds ?? new Set<string>();
  const claimed = new Set<string>(failed);
  const byId = new Map(input.lanes.map((lane) => [lane.id, lane]));
  const actions: LaneAction[] = [];

  const depsDone = (lane: LaneSnapshot): boolean =>
    lane.after.every((depId) => byId.get(depId)?.state === "done");

  const assignedTo = (lane: LaneSnapshot, providerName: string): boolean => {
    if (lane.assignedProvider) return lane.assignedProvider === providerName;
    if (lane.provider === "any") return true;
    return lane.provider === providerName;
  };

  for (const provider of input.providers) {
    const workingCount = input.lanes.filter(
      (lane) =>
        (lane.state === "working" || lane.state === "unknown") &&
        assignedTo(lane, provider.name)
    ).length;
    if (workingCount >= provider.maxActive) continue;

    const nudgeTarget = input.lanes.find((lane) => {
      if (claimed.has(lane.id)) return false;
      if (lane.state !== "paused") return false;
      if (!assignedTo(lane, provider.name)) return false;
      if (!depsDone(lane)) return false;
      if (!lane.lastUserMessageAt) return false;
      if (
        provider.maxNudges !== undefined &&
        lane.nudgeCount >= provider.maxNudges
      ) {
        return false;
      }
      const last = Date.parse(lane.lastUserMessageAt);
      if (!Number.isFinite(last)) return false;
      const ageHours = (input.now.getTime() - last) / 3_600_000;
      return ageHours >= provider.gapHours;
    });
    if (nudgeTarget) {
      claimed.add(nudgeTarget.id);
      actions.push({
        type: "nudge",
        laneId: nudgeTarget.id,
        provider: provider.name,
      });
      continue;
    }

    const promptTarget = input.lanes.find((lane) => {
      if (claimed.has(lane.id)) return false;
      if (lane.state !== "initializing") return false;
      if (!assignedTo(lane, provider.name)) return false;
      if (!isOrphanedFirstPrompt(lane)) return false;
      if (
        provider.maxNudges !== undefined &&
        lane.promptFailedCount >= provider.maxNudges
      ) {
        return false;
      }
      return depsDone(lane);
    });
    if (promptTarget) {
      claimed.add(promptTarget.id);
      actions.push({
        type: "prompt",
        laneId: promptTarget.id,
        provider: provider.name,
      });
      continue;
    }

    const createTarget = input.lanes.find((lane) => {
      if (claimed.has(lane.id)) return false;
      if (lane.state !== "not_created") return false;
      if (lane.provider !== provider.name && lane.provider !== "any") {
        return false;
      }
      return depsDone(lane);
    });
    if (createTarget) {
      claimed.add(createTarget.id);
      actions.push({
        type: "create",
        laneId: createTarget.id,
        provider: provider.name,
      });
    }
  }

  return actions;
}

const ORPHANED_PROMPT_ACTIONS = new Set(["create_failed", "prompt_failed"]);

function isOrphanedFirstPrompt(lane: LaneSnapshot): boolean {
  return ORPHANED_PROMPT_ACTIONS.has(lane.lastActionKind ?? "");
}
