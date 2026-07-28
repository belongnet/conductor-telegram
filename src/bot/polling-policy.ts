export interface PolledSessionStatus {
  status: string | null;
}

export type CloudSessionCyclePhase =
  | "pending"
  | "boundary"
  | "working"
  | "observed"
  | "canceling"
  | "complete";

export interface CloudSessionCycle {
  phase: CloudSessionCyclePhase;
  outboundMessageId?: string;
  baselineRowid?: number;
  boundaryRowid?: number;
}

export interface CloudCycleMessage {
  messageId: string | null;
  rowid: number;
  role: string;
}

export function cloudSessionCycleKey(
  conductorWorkspaceId: string,
  sessionId: string
): string {
  return `cloud_session_cycle:${conductorWorkspaceId}:${sessionId}`;
}

export function encodeCloudSessionCycle(cycle: CloudSessionCycle): string {
  return JSON.stringify(cycle);
}

export function parseCloudSessionCycle(
  value: string | null | undefined
): CloudSessionCycle | null {
  if (!value) return null;
  // Compatibility with the first prerelease implementation.
  if (value === "pending" || value === "observed" || value === "complete") {
    return { phase: value };
  }
  try {
    const parsed = JSON.parse(value) as Partial<CloudSessionCycle>;
    if (
      parsed.phase !== "pending" &&
      parsed.phase !== "boundary" &&
      parsed.phase !== "working" &&
      parsed.phase !== "observed" &&
      parsed.phase !== "canceling" &&
      parsed.phase !== "complete"
    ) {
      return null;
    }
    return {
      phase: parsed.phase,
      ...(typeof parsed.outboundMessageId === "string" &&
      parsed.outboundMessageId
        ? { outboundMessageId: parsed.outboundMessageId }
        : {}),
      ...(Number.isFinite(parsed.baselineRowid) &&
      Number(parsed.baselineRowid) >= 0
        ? { baselineRowid: Math.trunc(Number(parsed.baselineRowid)) }
        : {}),
      ...(Number.isFinite(parsed.boundaryRowid) &&
      Number(parsed.boundaryRowid) >= 0
        ? { boundaryRowid: Math.trunc(Number(parsed.boundaryRowid)) }
        : {}),
    };
  } catch {
    return null;
  }
}

export function cloudCycleIsInFlight(
  cycle: CloudSessionCycle | null
): boolean {
  return (
    cycle?.phase === "pending" ||
    cycle?.phase === "boundary" ||
    cycle?.phase === "working" ||
    cycle?.phase === "canceling"
  );
}

export function advanceCloudSessionCycle(input: {
  cycle: CloudSessionCycle | null;
  status: string | null;
  messages: CloudCycleMessage[];
}): CloudSessionCycle | null {
  const { status, messages } = input;
  let cycle = input.cycle;

  if (cycle?.phase === "canceling") {
    return status === "idle" || status === "error"
      ? { phase: "complete" }
      : cycle;
  }

  if (cycle?.phase === "pending") {
    if (!cycle.outboundMessageId) return cycle;
    const outboundMessageId = cycle.outboundMessageId;
    const baselineRowid = cycle.baselineRowid ?? -1;
    const boundary = messages.find(
      (message) =>
        message.messageId === outboundMessageId &&
        message.rowid > baselineRowid
    );
    if (!boundary) return cycle;
    cycle = {
      phase: "boundary",
      outboundMessageId: cycle.outboundMessageId,
      baselineRowid: cycle.baselineRowid,
      boundaryRowid: boundary.rowid,
    };
  }

  if (cycle?.phase === "boundary") {
    const boundaryRowid = cycle.boundaryRowid;
    const assistantAfterBoundary = messages.some(
      (message) =>
        message.role === "assistant" &&
        (boundaryRowid === undefined || message.rowid > boundaryRowid)
    );
    if (assistantAfterBoundary) {
      return { ...cycle, phase: "observed" };
    }
    if (status === "working") {
      return { ...cycle, phase: "working" };
    }
    return cycle;
  }

  if (cycle?.phase === "working") {
    if (status === "idle") {
      return { ...cycle, phase: "observed" };
    }
    return cycle;
  }

  if (cycle?.phase === "observed") return cycle;

  if (
    status === "working" ||
    messages.some((message) => message.role === "assistant")
  ) {
    return { phase: "observed" };
  }
  return cycle;
}

export function shouldPollTrackedWorkspace(input: {
  status: string;
  cloudOnly: boolean;
}): boolean {
  return input.status !== "archived";
}

export function canCompletePolledWorkspace(input: {
  remote: boolean;
  sessions: PolledSessionStatus[];
  cloudWorkObserved: boolean;
  cloudWorkPending: boolean;
}): boolean {
  if (input.sessions.length === 0) return false;
  if (input.remote) {
    return (
      !input.cloudWorkPending &&
      input.cloudWorkObserved &&
      input.sessions.every((session) => session.status === "idle")
    );
  }
  return input.sessions.every(
    (session) => session.status !== "working" && session.status !== "error"
  );
}
