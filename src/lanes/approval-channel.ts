/**
 * Command Center's emailed-code approval channel: the standardized Belong OTP
 * flow for approvers outside the browser. The channel key only lets this
 * service ask for a code and relay the one the owner types back; the grant that
 * comes back is the human proof, for a short window. Codes and grants live in
 * this process's memory only. They never reach a log, an error message or disk.
 */
/**
 * Human proof for a human-gated control: the approval channel key plus a live
 * grant from an emailed code. Held in memory only; never logged or persisted.
 */
export type LaneHumanApproval = {
  channelKey: string;
  grant: string;
};

/** Command Center's 401 detail for a missing, expired or invalid grant. */
export const FRESH_APPROVAL_REQUIRED = "A fresh approval code is required";

/** This service's channel name at Command Center; it has its own code budget. */
export const APPROVAL_CHANNEL = "conductor-lanes";
export const APPROVAL_CHANNEL_KEY_ENV = "BELONG_APPROVAL_CHANNEL_KEY";
/** Grants nothing anymore. Command Center refuses requests that still send it. */
export const RETIRED_APPROVAL_KEY_ENV = "BELONG_HUMAN_APPROVAL_KEY";
export const APPROVAL_CHANNEL_KEY_HEADER = "x-belong-approval-channel-key";
export const APPROVAL_GRANT_HEADER = "x-belong-approval-grant";
export const APPROVAL_CODE_PATTERN = /^\d{6}$/;

const MIN_CHANNEL_KEY_LENGTH = 40;
const CHANNEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SUBJECT_PATTERN = /^[\x20-\x7e]{1,80}$/;
const CHALLENGE_PATTERN = /^[\x21-\x7e]{1,200}$/;
const GRANT_PATTERN = /^[A-Za-z0-9_-]{32,512}={0,2}$/;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
/** A grant counts as expired this long before Command Center would say so. */
const GRANT_MARGIN_MS = 10_000;
const UNKNOWN_MAILBOX = "the approval mailbox";

/** Command Center keys this one must never equal. */
const DISTINCT_FROM = [
  "COMMAND_CENTER_API_KEY",
  "BELONG_AGENTS_API_KEY",
  "BELONG_AGENTS_API_KEYS",
  "BELONG_NOTIFICATION_WORKER_API_KEY",
  "BELONG_CONDUCTOR_CLOUD_SYNC_API_KEY",
  "CONDUCTOR_API_KEY",
  RETIRED_APPROVAL_KEY_ENV,
] as const;

/** Why Command Center turned a send or verify down. A closed set; its wording goes no further. */
export type ApprovalRefusal = "invalid" | "expired" | "attempts" | "wait" | "unavailable";

export class ApprovalChannelError extends Error {
  constructor(
    readonly reason: ApprovalRefusal,
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApprovalChannelError";
  }

  /** Command Center refused this service's channel key, not the code. */
  get channelKeyRefused(): boolean {
    return this.reason === "unavailable" && this.status === 401;
  }
}

export class ApprovalCodeInvalidError extends ApprovalChannelError {
  constructor(status?: number) {
    super("invalid", "The approval code was not accepted", status);
    this.name = "ApprovalCodeInvalidError";
  }
}

export class ApprovalCodeExpiredError extends ApprovalChannelError {
  constructor(status?: number) {
    super("expired", "The approval code has expired", status);
    this.name = "ApprovalCodeExpiredError";
  }
}

export class ApprovalAttemptsError extends ApprovalChannelError {
  constructor(status?: number, retryAfterSeconds?: number) {
    super("attempts", "Too many approval attempts", status, retryAfterSeconds);
    this.name = "ApprovalAttemptsError";
  }
}

export class ApprovalWaitError extends ApprovalChannelError {
  constructor(status?: number, retryAfterSeconds?: number) {
    super("wait", "Approval codes are on hold", status, retryAfterSeconds);
    this.name = "ApprovalWaitError";
  }
}

export class ApprovalUnavailableError extends ApprovalChannelError {
  constructor(status?: number) {
    super("unavailable", "The approval service is unavailable", status);
    this.name = "ApprovalUnavailableError";
  }
}

export interface ApprovalChallenge {
  challengeId: string;
  /** Command Center's masked mailbox, safe to show. */
  emailHint: string;
  expiresInSeconds: number;
  /** Local clock, in milliseconds. */
  expiresAt: number;
}

export interface ApprovalChannelOptions {
  baseUrl: string;
  channelKey: string;
  /** Who types the code, such as `telegram:6262626262`. */
  subject: string;
  channel?: string;
  /** Command Center service key, sent as `x-api-key` when configured. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

type ChannelResponse = { status: number; body: unknown; headers: Headers };

export class ApprovalChannelClient {
  readonly channel: string;
  readonly subject: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  // Private fields stay out of inspection and serialization.
  readonly #channelKey: string;
  readonly #apiKey: string | undefined;
  #grant: { value: string; expiresAt: number } | undefined;

  constructor(options: ApprovalChannelOptions) {
    const channel = options.channel ?? APPROVAL_CHANNEL;
    if (!CHANNEL_PATTERN.test(channel)) throw new Error("approval channel name is invalid");
    if (!SUBJECT_PATTERN.test(options.subject)) {
      throw new Error("approval subject must be 1-80 printable characters");
    }
    let base: URL;
    try {
      base = new URL(options.baseUrl);
    } catch {
      throw new Error("COMMAND_CENTER_API_BASE_URL is not a URL");
    }
    if (base.protocol !== "https:" && base.protocol !== "http:") {
      throw new Error("COMMAND_CENTER_API_BASE_URL must be http or https");
    }
    if (!options.channelKey) throw new Error(`${APPROVAL_CHANNEL_KEY_ENV} is required`);
    this.channel = channel;
    this.subject = options.subject;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.#channelKey = options.channelKey;
    this.#apiKey = options.apiKey || undefined;
  }

  /** Asks Command Center to email a fresh code to the approval mailbox. */
  async sendCode(): Promise<ApprovalChallenge> {
    const response = await this.call("POST", "/api/operator/otp/channel/send", {
      channel: this.channel,
      subject: this.subject,
    });
    if (response.status !== 200) throw refusal(response, false);
    const body = record(response.body);
    const challengeId = body?.challenge_id;
    const expiresIn = seconds(body?.expires_in);
    if (typeof challengeId !== "string" || !CHALLENGE_PATTERN.test(challengeId) || expiresIn === undefined) {
      throw new ApprovalUnavailableError(response.status);
    }
    return {
      challengeId,
      emailHint: mailboxHint(body?.email_hint),
      expiresInSeconds: expiresIn,
      expiresAt: this.now() + expiresIn * 1000,
    };
  }

  /**
   * Relays the owner's code. On success the grant is kept in memory until it
   * expires or is dropped; the code itself is not kept at all.
   */
  async verifyCode(challengeId: string, code: string): Promise<{ expiresAt: number }> {
    if (!APPROVAL_CODE_PATTERN.test(code)) throw new ApprovalCodeInvalidError();
    if (!CHALLENGE_PATTERN.test(challengeId)) throw new ApprovalCodeExpiredError();
    const response = await this.call("POST", "/api/operator/otp/channel/verify", {
      challenge_id: challengeId,
      code,
    });
    if (response.status !== 200) throw refusal(response, true);
    const body = record(response.body);
    const grant = body?.grant;
    if (typeof grant !== "string" || !GRANT_PATTERN.test(grant)) {
      throw new ApprovalUnavailableError(response.status);
    }
    // A grant issued to another channel or person is not this approver's proof.
    if (
      (body?.channel !== undefined && body.channel !== this.channel) ||
      (body?.subject !== undefined && body.subject !== this.subject)
    ) {
      throw new ApprovalUnavailableError(response.status);
    }
    const now = this.now();
    const expiresIn = seconds(body?.expires_in);
    const candidates = [
      expiresIn === undefined ? undefined : now + expiresIn * 1000,
      instant(body?.expires_at),
    ].filter((value): value is number => value !== undefined);
    // The earlier of the two: a fast local clock then ends the window early, never late.
    const expiresAt = candidates.length ? Math.min(...candidates) : undefined;
    if (expiresAt === undefined || expiresAt <= now) {
      throw new ApprovalUnavailableError(response.status);
    }
    this.#grant = { value: grant, expiresAt };
    return { expiresAt };
  }

  /** The human proof for a control while the grant is live; null otherwise. */
  approval(): LaneHumanApproval | null {
    const grant = this.#grant;
    if (!grant) return null;
    if (this.now() >= grant.expiresAt - GRANT_MARGIN_MS) {
      this.#grant = undefined;
      return null;
    }
    return { channelKey: this.#channelKey, grant: grant.value };
  }

  /** The two approval headers while the grant is live; null otherwise. */
  grantHeaders(): Record<string, string> | null {
    const approval = this.approval();
    return approval ? approvalHeaders(approval) : null;
  }

  /** When the live grant ends, local clock; null without one. */
  grantExpiresAt(): number | null {
    return this.approval() ? this.#grant!.expiresAt : null;
  }

  dropGrant(): void {
    this.#grant = undefined;
  }

  /** Forgets the grant and asks Command Center to revoke it. Best effort. */
  async revokeGrant(): Promise<boolean> {
    const grant = this.#grant;
    this.#grant = undefined;
    if (!grant) return false;
    try {
      const response = await this.call(
        "DELETE",
        "/api/operator/otp/channel/grant",
        undefined,
        { [APPROVAL_GRANT_HEADER]: grant.value }
      );
      return response.status >= 200 && response.status < 300;
    } catch {
      return false;
    }
  }

  private async call(
    method: "POST" | "DELETE",
    endpoint: string,
    body?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {}
  ): Promise<ChannelResponse> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      [APPROVAL_CHANNEL_KEY_HEADER]: this.#channelKey,
      ...extraHeaders,
    };
    if (this.#apiKey) headers["x-api-key"] = this.#apiKey;
    if (body !== undefined) headers["content-type"] = "application/json";
    // A plain timer, not AbortSignal.timeout: that one is unref'd, so a hung
    // call in a short-lived process could outlive its own deadline.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // A redirect could carry the channel key or a code somewhere else.
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new ApprovalUnavailableError();
      }
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApprovalUnavailableError(response.status);
      }
      let text: string;
      try {
        text = await readBounded(response, MAX_RESPONSE_BYTES);
      } catch {
        throw new ApprovalUnavailableError(response.status);
      }
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          if (response.ok) throw new ApprovalUnavailableError(response.status);
        }
      }
      return { status: response.status, body: parsed, headers: response.headers };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function approvalHeaders(approval: LaneHumanApproval): Record<string, string> {
  return {
    [APPROVAL_CHANNEL_KEY_HEADER]: approval.channelKey,
    [APPROVAL_GRANT_HEADER]: approval.grant,
  };
}

/** What is wrong with a channel key, or null when it is usable. Never echoes a value. */
export function approvalChannelKeyProblem(
  key: string | undefined,
  env: NodeJS.ProcessEnv = {}
): string | null {
  if (!key) return `${APPROVAL_CHANNEL_KEY_ENV} is not set`;
  if (/\s/.test(key)) return `${APPROVAL_CHANNEL_KEY_ENV} must not contain whitespace`;
  if (key.length < MIN_CHANNEL_KEY_LENGTH) {
    return `${APPROVAL_CHANNEL_KEY_ENV} must be at least ${MIN_CHANNEL_KEY_LENGTH} characters`;
  }
  for (const name of DISTINCT_FROM) {
    const values = (env[name] ?? "").split(/[\s,]+/).filter(Boolean);
    if (values.includes(key)) return `${APPROVAL_CHANNEL_KEY_ENV} must differ from ${name}`;
  }
  return null;
}

export type ApprovalChannelSetup = { client: ApprovalChannelClient } | { problem: string };

/** The channel client this environment configures, or why there is none. */
export function approvalChannelFromEnv(
  env: NodeJS.ProcessEnv,
  subject: string,
  options: Pick<ApprovalChannelOptions, "fetchImpl" | "now" | "timeoutMs"> = {}
): ApprovalChannelSetup {
  const baseUrl = env.COMMAND_CENTER_API_BASE_URL?.trim();
  const channelKey = env[APPROVAL_CHANNEL_KEY_ENV]?.trim();
  if (!baseUrl || !channelKey) {
    return { problem: `set ${APPROVAL_CHANNEL_KEY_ENV} and COMMAND_CENTER_API_BASE_URL` };
  }
  const keyProblem = approvalChannelKeyProblem(channelKey, env);
  if (keyProblem) return { problem: keyProblem };
  try {
    return {
      client: new ApprovalChannelClient({
        ...options,
        baseUrl,
        channelKey,
        subject,
        apiKey: env.COMMAND_CENTER_API_KEY?.trim() || env.BELONG_AGENTS_API_KEY?.trim(),
      }),
    };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : "the approval channel is misconfigured" };
  }
}

function refusal(response: ChannelResponse, verifying: boolean): ApprovalChannelError {
  const body = record(response.body);
  const reason = typeof body?.reason === "string" ? body.reason : undefined;
  const retryAfter = retryAfterSeconds(body?.retry_after, response.headers.get("retry-after"));
  if (response.status === 429) {
    return reason === "attempts"
      ? new ApprovalAttemptsError(response.status, retryAfter)
      : new ApprovalWaitError(response.status, retryAfter);
  }
  if (response.status === 401 && verifying) {
    if (reason === "invalid") return new ApprovalCodeInvalidError(response.status);
    if (reason === "expired") return new ApprovalCodeExpiredError(response.status);
    if (reason === "attempts") return new ApprovalAttemptsError(response.status, retryAfter);
  }
  // A refused channel key, an outage, or anything this client does not know.
  return new ApprovalUnavailableError(response.status);
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A positive lifetime in seconds, as a JSON number or a numeric string. */
function seconds(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0 && number <= MAX_LIFETIME_SECONDS ? number : undefined;
}

function instant(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // Epoch seconds or milliseconds.
    return value < 1e11 ? value * 1000 : value;
  }
  return undefined;
}

function retryAfterSeconds(fromBody: unknown, header: string | null): number | undefined {
  const bounded = (value: number): number | undefined =>
    Number.isFinite(value) && value >= 0 ? Math.min(Math.ceil(value), MAX_LIFETIME_SECONDS) : undefined;
  if (typeof fromBody === "number") return bounded(fromBody);
  if (typeof fromBody === "string" && /^\d+(?:\.\d+)?$/.test(fromBody.trim())) return bounded(Number(fromBody));
  if (header === null) return undefined;
  if (/^\d+$/.test(header.trim())) return bounded(Number(header.trim()));
  const at = Date.parse(header);
  return Number.isFinite(at) ? bounded((at - Date.now()) / 1000) : undefined;
}

/** Control, zero-width, bidirectional and other invisible characters. */
const INVISIBLE = new RegExp(
  `[${[
    [0x00, 0x1f],
    [0x7f, 0x9f],
    [0x200b, 0x200f],
    [0x2028, 0x202e],
    [0x2060, 0x206f],
    [0xfeff, 0xfeff],
  ]
    .map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`)
    .join("")}]`,
  "g"
);

/** Shown in Telegram and on terminals, so it is one short line of visible text. */
function mailboxHint(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_MAILBOX;
  const visible = value
    .replace(INVISIBLE, "")
    .trim()
    .slice(0, 80);
  return visible || UNKNOWN_MAILBOX;
}
