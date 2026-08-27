import { truncateHtml } from "./format.js";

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
  /** Epoch ms the cycle was reserved; used to expire a stuck `pending`. */
  startedAt?: number;
}

/**
 * How long a cycle may sit in `pending` before it is abandoned.
 *
 * `pending` only waits for the bot to observe the message it just sent, which
 * resolves within a poll tick or two. A restart between reserving the cycle
 * and recording its outbound id — or a cursor baselined past that message —
 * would otherwise strand the thread forever: every later send is rejected as
 * in-flight and the workspace can never complete. Later phases track real
 * agent work and are deliberately not bounded.
 */
export const CLOUD_CYCLE_PENDING_TTL_MS = 10 * 60 * 1000;

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
      ...(Number.isFinite(parsed.startedAt) && Number(parsed.startedAt) >= 0
        ? { startedAt: Math.trunc(Number(parsed.startedAt)) }
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
  now?: number;
}): CloudSessionCycle | null {
  const { status, messages } = input;
  const now = input.now ?? Date.now();
  let cycle = input.cycle;

  if (cycle?.phase === "canceling") {
    return status === "idle" || status === "error"
      ? { phase: "complete" }
      : cycle;
  }

  if (cycle?.phase === "pending") {
    // Abandoning a stuck reservation is safe: the worst case is that a reply
    // to an already-delivered message is attributed to the next cycle, which
    // is strictly better than blocking the thread permanently.
    const expired =
      cycle.startedAt !== undefined &&
      now - cycle.startedAt > CLOUD_CYCLE_PENDING_TTL_MS;
    if (!cycle.outboundMessageId) return expired ? { phase: "complete" } : cycle;
    const outboundMessageId = cycle.outboundMessageId;
    const baselineRowid = cycle.baselineRowid ?? -1;
    const boundary = messages.find(
      (message) =>
        message.messageId === outboundMessageId &&
        message.rowid > baselineRowid
    );
    if (!boundary) return expired ? { phase: "complete" } : cycle;
    cycle = {
      phase: "boundary",
      outboundMessageId: cycle.outboundMessageId,
      baselineRowid: cycle.baselineRowid,
      boundaryRowid: boundary.rowid,
      ...(cycle.startedAt !== undefined ? { startedAt: cycle.startedAt } : {}),
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

/**
 * Caps the per-tick request fan-out at the beta Conductor API.
 *
 * A workspace can hold hundreds of sessions, and every tracked workspace polls
 * on the same timer. Firing one request per session at once earns 429s, which
 * are retryable and so turn into a retry storm that never converges.
 */
export const MAX_CONCURRENT_SESSION_REQUESTS = 6;

/**
 * Truncate to a hard ceiling. `truncateHtml` budgets for the text it keeps and
 * then appends its ellipsis and any closing tags, so it overshoots the length
 * it was given; re-cutting by the measured overshoot lands under the ceiling
 * without having to guess how many tags were left open.
 */
function fitTelegramHtml(html: string, maxLength: number): string {
  let budget = maxLength;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = truncateHtml(html, budget);
    if (candidate.length <= maxLength) return candidate;
    budget -= candidate.length - maxLength;
  }
  // A raw slice could land inside a tag or entity and be rejected outright,
  // which would strand the notice this exists to get published.
  return "<pre>(notice omitted: too large to display)</pre>";
}

/**
 * Pack complete HTML fragments below Telegram's message-size ceiling.
 *
 * A single oversized fragment is truncated rather than rejected. These entries
 * carry recovery notices that are only acknowledged once they are published, so
 * throwing here would fail the same notice on every poll and leave the
 * workspace permanently unpolled.
 */
export function chunkTelegramHtmlEntries<T extends { html: string }>(
  entries: readonly T[],
  maxLength = 3_500
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let currentLength = 0;
  for (const original of entries) {
    const entry =
      original.html.length > maxLength
        ? { ...original, html: fitTelegramHtml(original.html, maxLength) }
        : original;
    const nextLength =
      currentLength + (current.length > 0 ? 2 : 0) + entry.html.length;
    if (current.length > 0 && nextLength > maxLength) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(entry);
    currentLength += (current.length > 1 ? 2 : 0) + entry.html.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    })
  );
  return results;
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
