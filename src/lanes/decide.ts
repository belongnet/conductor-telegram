export const LANE_NUDGE_MESSAGE =
  "Continue where you left off; end with the PR URL.";

export const GITHUB_PR_URL_RE =
  /https?:\/\/(?:www\.)?github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/i;

export type LaneRuntimeState =
  | "working"
  | "done"
  | "paused"
  | "initializing"
  | "not_created";

export type LaneSnapshot = {
  id: string;
  /** Configured provider, or `"any"`. */
  provider: string;
  /**
   * Provider currently occupying this lane. Named lanes use their config
   * provider once created; `"any"` lanes use the provider recorded in the
   * workspace name.
   */
  assignedProvider: string | null;
  state: LaneRuntimeState;
  lastUserMessageAt: string | null;
  after: string[];
};

export type ProviderLimits = {
  name: string;
  gapHours: number;
  maxActive: number;
};

export type LaneAction =
  | { type: "nudge"; laneId: string; provider: string }
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

export function transcriptEventText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
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

  if (userEvents.length === 0) {
    return { state: "initializing", lastUserMessageAt: null };
  }

  if (input.sessionStatus === "working") {
    return { state: "working", lastUserMessageAt };
  }

  const done = input.messages.some(
    (message) =>
      isAgentTranscriptEvent(message) &&
      transcriptContainsGithubPrUrl(transcriptEventText(message.content))
  );
  if (done) {
    return { state: "done", lastUserMessageAt };
  }

  return { state: "paused", lastUserMessageAt };
}

/**
 * Pure scheduler: at most one action per provider whose working count is
 * below `maxActive`. Nudge the first eligible paused lane; otherwise create
 * the first not-created lane for that provider (or `"any"`). Failed lanes
 * are skipped so the queue can advance.
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
    return lane.provider === providerName;
  };

  for (const provider of input.providers) {
    const workingCount = input.lanes.filter(
      (lane) =>
        lane.state === "working" && assignedTo(lane, provider.name)
    ).length;
    if (workingCount >= provider.maxActive) continue;

    const nudgeTarget = input.lanes.find((lane) => {
      if (claimed.has(lane.id)) return false;
      if (lane.state !== "paused") return false;
      if (!assignedTo(lane, provider.name)) return false;
      if (!depsDone(lane)) return false;
      if (!lane.lastUserMessageAt) return false;
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
