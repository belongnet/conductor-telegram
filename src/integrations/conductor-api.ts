import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://api.conductor.build";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;

const IdSchema = z.string().min(1);

const ApiMessageSchema = z.object({
  id: IdSchema,
  sessionId: IdSchema,
  sessionIndex: z.number().finite().nonnegative(),
  type: z.string(),
  content: z.unknown(),
  receivedAt: z.string(),
});

const MessagePageSchema = z.object({
  data: z.array(ApiMessageSchema),
  offset: z.number().finite().nonnegative(),
  hasMore: z.boolean(),
});

const SessionSchema = z.object({
  id: IdSchema,
  deepLink: z.string(),
  name: z.string().optional(),
  model: z.string().optional(),
  resolvedModel: z.string().optional(),
  effort: z.string().optional(),
  fastMode: z.boolean().optional(),
  archivedAt: z.string().nullable().optional(),
});

const WorkspaceSchema = z.object({
  id: IdSchema,
  name: z.string(),
  createdAt: z.string(),
  deepLink: z.string(),
  creatorId: z.string().optional(),
  lastActivityAt: z.string().optional(),
});

const SessionPageSchema = z.object({
  data: z.array(SessionSchema),
  offset: z.number().finite().nonnegative(),
  hasMore: z.boolean(),
});

const ProjectSchema = z.object({
  id: IdSchema,
  name: z.string(),
  gitRemote: z.string(),
});

const ProjectPageSchema = z.object({
  data: z.array(ProjectSchema),
  offset: z.number().finite().nonnegative(),
  hasMore: z.boolean(),
});

const WorkspacePageSchema = z.object({
  data: z.array(WorkspaceSchema),
  offset: z.number().finite().nonnegative(),
  hasMore: z.boolean(),
});

const SqlResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().finite().nonnegative(),
  truncated: z.boolean(),
});

const SessionStatusSchema = z.object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  status: z.enum(["idle", "working", "error"]),
  updatedAt: z.string(),
  errorMessage: z.string().optional(),
  lastError: z.string().optional(),
  lastErrorAt: z.string().optional(),
});

const WorkspaceStatusSchema = z.object({
  workspaceId: IdSchema,
  status: z.enum([
    "initializing",
    "ready",
    "sleeping",
    "archived",
    "deleted",
    "updating",
  ]),
  lifecycleStep: z
    .enum(["building_snapshot", "preparing", "setting_up", "updating"])
    .optional(),
  updatedAt: z.string(),
  errorMessage: z.string().optional(),
});

const MessageCreateSchema = z.object({
  messageId: IdSchema,
  state: z.enum(["queued", "sent"]),
});

const SessionCancelSchema = z.object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  status: z.enum(["idle", "working", "error"]),
  canceledQueuedMessages: z.number().finite().nonnegative(),
});

const SessionArchiveSchema = z.object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  status: z.literal("archived"),
  canceledQueuedMessages: z.number().finite().nonnegative(),
});

const WorkspaceArchiveSchema = z.object({
  workspaceId: IdSchema,
  status: z.literal("archived"),
});

const WorkspaceCreateSchema = z.object({
  workspaceId: IdSchema,
  sessionId: IdSchema,
  deepLink: z.string(),
});

const IdentitySchema = z.object({
  userId: IdSchema,
  email: z.string().optional(),
  organizationId: z.string().optional(),
  workspaceId: z.string().optional(),
  authMethod: z.enum(["api-key", "access-jwt", "legacy-api-token"]),
  apiKey: z.object({ id: IdSchema }).optional(),
});

export type ConductorApiMessage = z.infer<typeof ApiMessageSchema>;
export type ConductorApiSession = z.infer<typeof SessionSchema>;
export type ConductorApiWorkspace = z.infer<typeof WorkspaceSchema>;
export type ConductorApiSessionStatus = z.infer<typeof SessionStatusSchema>;
export type ConductorApiWorkspaceStatus = z.infer<typeof WorkspaceStatusSchema>;
export type ConductorApiIdentity = z.infer<typeof IdentitySchema>;
export type ConductorApiProject = z.infer<typeof ProjectSchema>;
export type ConductorApiSqlResult = z.infer<typeof SqlResultSchema>;

export type ConductorCloudBackendMode = "auto" | "api" | "off";

export interface ConductorApiConfig {
  /** API origin without the /v0 suffix. */
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  /**
   * Session to attribute requests to via X-Conductor-Session-Id when the bot
   * itself runs inside a Conductor cloud workspace (CONDUCTOR_SESSION_ID).
   */
  attributedSessionId?: string;
}

export class ConductorApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "ConductorApiError";
  }
}

export function conductorCloudBackendModeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ConductorCloudBackendMode {
  const raw = env.CONDUCTOR_CLOUD_BACKEND?.trim().toLowerCase();
  if (!raw) {
    // Preserve the old explicit off switch, but never preserve its private DB
    // queue writer. "queue" now behaves like auto and requires an API key.
    return env.TELEGRAM_REMOTE_STEERING?.trim().toLowerCase() === "off"
      ? "off"
      : "auto";
  }
  if (raw === "auto" || raw === "api" || raw === "off") {
    return raw;
  }
  throw new ConductorApiError(
    "CONDUCTOR_CLOUD_BACKEND must be one of: auto, api, off"
  );
}

export function conductorApiConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ConductorApiConfig | null {
  const mode = conductorCloudBackendModeFromEnv(env);
  if (mode === "off") return null;

  const apiKey = env.CONDUCTOR_API_KEY?.trim() ?? "";
  if (!apiKey) {
    if (mode === "api") {
      throw new ConductorApiError(
        "CONDUCTOR_CLOUD_BACKEND=api requires CONDUCTOR_API_KEY"
      );
    }
    return null;
  }

  // Cloud workspaces export CONDUCTOR_API_URL; an explicit
  // CONDUCTOR_API_BASE_URL still wins so operators can override it.
  const baseUrl = normalizeApiBaseUrl(
    env.CONDUCTOR_API_BASE_URL?.trim() ||
      env.CONDUCTOR_API_URL?.trim() ||
      DEFAULT_BASE_URL
  );
  const timeoutMs = parsePositiveInteger(
    env.CONDUCTOR_API_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    "CONDUCTOR_API_TIMEOUT_MS"
  );
  const maxRetries = parseNonnegativeInteger(
    env.CONDUCTOR_API_MAX_RETRIES,
    DEFAULT_MAX_RETRIES,
    "CONDUCTOR_API_MAX_RETRIES"
  );
  if (timeoutMs > 120_000) {
    throw new ConductorApiError(
      "CONDUCTOR_API_TIMEOUT_MS must be at most 120000"
    );
  }
  if (maxRetries > 5) {
    throw new ConductorApiError(
      "CONDUCTOR_API_MAX_RETRIES must be at most 5"
    );
  }
  return {
    baseUrl,
    apiKey,
    timeoutMs,
    maxRetries,
    attributedSessionId: env.CONDUCTOR_SESSION_ID?.trim() || undefined,
  };
}

export function isConductorCloudApiConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  try {
    return conductorApiConfigFromEnv(env) !== null;
  } catch {
    return false;
  }
}

export class ConductorApiClient {
  private readonly config: ConductorApiConfig;

  constructor(
    config: ConductorApiConfig,
    private readonly fetcher: typeof fetch = globalThis.fetch
  ) {
    this.config = {
      ...config,
      baseUrl: normalizeApiBaseUrl(config.baseUrl),
    };
  }

  getIdentity(): Promise<ConductorApiIdentity> {
    return this.request("GET", "/me", IdentitySchema);
  }

  async getSession(sessionId: string): Promise<ConductorApiSession> {
    const session = await this.request(
      "GET",
      `/v0/sessions/${encodeURIComponent(sessionId)}`,
      SessionSchema
    );
    assertApiIdentity("session", sessionId, session.id);
    return session;
  }

  async getWorkspace(workspaceId: string): Promise<ConductorApiWorkspace> {
    const workspace = await this.request(
      "GET",
      `/v0/workspaces/${encodeURIComponent(workspaceId)}`,
      WorkspaceSchema
    );
    assertApiIdentity("workspace", workspaceId, workspace.id);
    return workspace;
  }

  async getSessionStatus(sessionId: string): Promise<ConductorApiSessionStatus> {
    const status = await this.request(
      "GET",
      `/v0/sessions/${encodeURIComponent(sessionId)}/status`,
      SessionStatusSchema
    );
    assertApiIdentity("session", sessionId, status.sessionId);
    return status;
  }

  async getWorkspaceStatus(
    workspaceId: string
  ): Promise<ConductorApiWorkspaceStatus> {
    const status = await this.request(
      "GET",
      `/v0/workspaces/${encodeURIComponent(workspaceId)}/status`,
      WorkspaceStatusSchema
    );
    assertApiIdentity("workspace", workspaceId, status.workspaceId);
    return status;
  }

  async listWorkspaceSessions(workspaceId: string): Promise<ConductorApiSession[]> {
    const sessions: ConductorApiSession[] = [];
    let offset = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.request(
        "GET",
        withQuery(
          `/v0/workspaces/${encodeURIComponent(workspaceId)}/sessions`,
          { limit: PAGE_SIZE, offset }
        ),
        SessionPageSchema
      );
      sessions.push(...page.data);
      if (!page.hasMore || page.data.length === 0) {
        return sessions;
      }
      offset += page.data.length;
    }
    throw new ConductorApiError(
      `Conductor API session pagination exceeded ${MAX_PAGES} pages`
    );
  }

  async listSessionMessages(input: {
    sessionId: string;
    after?: string | null;
    limit?: number;
  }): Promise<ConductorApiMessage[]> {
    const limit = Math.max(1, Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE));
    const page = await this.request(
      "GET",
      withQuery(
        `/v0/sessions/${encodeURIComponent(input.sessionId)}/messages`,
        { limit, after: input.after?.trim() || undefined }
      ),
      MessagePageSchema
    );
    assertMessageMembership(input.sessionId, page.data);
    return page.data;
  }

  async getLatestSessionMessage(
    sessionId: string
  ): Promise<ConductorApiMessage | null> {
    let offset = 0;
    let latest: ConductorApiMessage | null = null;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.request(
        "GET",
        withQuery(
          `/v0/sessions/${encodeURIComponent(sessionId)}/messages`,
          { limit: PAGE_SIZE, offset }
        ),
        MessagePageSchema
      );
      assertMessageMembership(sessionId, page.data);
      if (page.data.length > 0) {
        latest = page.data[page.data.length - 1];
      }
      if (!page.hasMore || page.data.length === 0) {
        return latest;
      }
      offset += page.data.length;
    }
    throw new ConductorApiError(
      `Conductor API message pagination exceeded ${MAX_PAGES} pages`
    );
  }

  async sendMessage(input: {
    sessionId: string;
    message: string;
    messageId: string;
  }): Promise<z.infer<typeof MessageCreateSchema>> {
    const result = await this.request(
      "POST",
      `/v0/sessions/${encodeURIComponent(input.sessionId)}/messages`,
      MessageCreateSchema,
      {
        body: {
          messageId: input.messageId,
          message: input.message,
        },
        retrySafe: true,
      }
    );
    assertApiIdentity("message", input.messageId, result.messageId);
    return result;
  }

  createSession(input: {
    workspaceId: string;
    name?: string;
    agent: "claude" | "codex";
    model?: string;
    effort?: string;
    fastMode?: boolean;
  }): Promise<ConductorApiSession> {
    return this.request("POST", "/v0/sessions", SessionSchema, {
      body: compactObject(input),
      // The public contract accepts a caller-provided sessionId, but this
      // integration deliberately does not retry creation until Conductor
      // documents idempotency for that field.
      retrySafe: false,
    });
  }

  createWorkspace(input:
    | {
        projectId: string;
        branch?: string;
        name?: string;
        sessionName?: string;
        agent?: "claude" | "codex";
        model?: string;
        effort?: string;
        env?: Record<string, string>;
      }
    | {
        repositoryUrl: string;
        branch?: string;
        name?: string;
        sessionName?: string;
        agent?: "claude" | "codex";
        model?: string;
        effort?: string;
        env?: Record<string, string>;
      }
  ): Promise<z.infer<typeof WorkspaceCreateSchema>> {
    return this.request("POST", "/v0/workspaces", WorkspaceCreateSchema, {
      body: compactObject(input),
      retrySafe: false,
    });
  }

  async cancelSession(
    sessionId: string
  ): Promise<z.infer<typeof SessionCancelSchema>> {
    const result = await this.request(
      "POST",
      `/v0/sessions/${encodeURIComponent(sessionId)}/cancel`,
      SessionCancelSchema,
      { retrySafe: true }
    );
    assertApiIdentity("session", sessionId, result.sessionId);
    return result;
  }

  async archiveSession(
    sessionId: string
  ): Promise<z.infer<typeof SessionArchiveSchema>> {
    const result = await this.request(
      "POST",
      `/v0/sessions/${encodeURIComponent(sessionId)}/archive`,
      SessionArchiveSchema,
      { retrySafe: true }
    );
    assertApiIdentity("session", sessionId, result.sessionId);
    return result;
  }

  async archiveWorkspace(
    workspaceId: string
  ): Promise<z.infer<typeof WorkspaceArchiveSchema>> {
    const result = await this.request(
      "POST",
      `/v0/workspaces/${encodeURIComponent(workspaceId)}/archive`,
      WorkspaceArchiveSchema,
      { retrySafe: true }
    );
    assertApiIdentity("workspace", workspaceId, result.workspaceId);
    return result;
  }

  async listProjects(): Promise<ConductorApiProject[]> {
    const projects: ConductorApiProject[] = [];
    let offset = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.request(
        "GET",
        withQuery("/v0/projects", { limit: PAGE_SIZE, offset }),
        ProjectPageSchema
      );
      projects.push(...page.data);
      if (!page.hasMore || page.data.length === 0) {
        return projects;
      }
      offset += page.data.length;
    }
    throw new ConductorApiError(
      `Conductor API project pagination exceeded ${MAX_PAGES} pages`
    );
  }

  async getProject(projectId: string): Promise<ConductorApiProject> {
    const project = await this.request(
      "GET",
      `/v0/projects/${encodeURIComponent(projectId)}`,
      ProjectSchema
    );
    assertApiIdentity("project", projectId, project.id);
    return project;
  }

  async listProjectWorkspaces(
    projectId: string
  ): Promise<ConductorApiWorkspace[]> {
    const workspaces: ConductorApiWorkspace[] = [];
    let offset = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const page = await this.request(
        "GET",
        withQuery(
          `/v0/projects/${encodeURIComponent(projectId)}/workspaces`,
          { limit: PAGE_SIZE, offset }
        ),
        WorkspacePageSchema
      );
      workspaces.push(...page.data);
      if (!page.hasMore || page.data.length === 0) {
        return workspaces;
      }
      offset += page.data.length;
    }
    throw new ConductorApiError(
      `Conductor API workspace pagination exceeded ${MAX_PAGES} pages`
    );
  }

  async renameWorkspace(
    workspaceId: string,
    name: string
  ): Promise<ConductorApiWorkspace> {
    const workspace = await this.request(
      "POST",
      `/v0/workspaces/${encodeURIComponent(workspaceId)}/rename`,
      WorkspaceSchema,
      // Renaming to the same name twice is a no-op, so retries are safe.
      { body: { name }, retrySafe: true }
    );
    assertApiIdentity("workspace", workspaceId, workspace.id);
    return workspace;
  }

  async renameSession(
    sessionId: string,
    name: string
  ): Promise<ConductorApiSession> {
    const session = await this.request(
      "POST",
      `/v0/sessions/${encodeURIComponent(sessionId)}/rename`,
      SessionSchema,
      { body: { name }, retrySafe: true }
    );
    assertApiIdentity("session", sessionId, session.id);
    return session;
  }

  async getMessage(messageId: string): Promise<ConductorApiMessage> {
    const message = await this.request(
      "GET",
      `/v0/messages/${encodeURIComponent(messageId)}`,
      ApiMessageSchema
    );
    assertApiIdentity("message", messageId, message.id);
    return message;
  }

  runSql(query: string): Promise<ConductorApiSqlResult> {
    // The endpoint only accepts read-only SELECTs over
    // session_transcripts_view, so replaying on failure is safe.
    return this.request("POST", "/v0/sql", SqlResultSchema, {
      body: { query },
      retrySafe: true,
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    apiPath: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; retrySafe?: boolean } = {}
  ): Promise<T> {
    const retrySafe = method === "GET" || options.retrySafe === true;
    const attempts = retrySafe ? this.config.maxRetries + 1 : 1;
    let lastError: ConductorApiError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const response = await this.fetcher(`${this.config.baseUrl}${apiPath}`, {
          method,
          redirect: "error",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "conductor-telegram",
            ...(this.config.attributedSessionId
              ? { "X-Conductor-Session-Id": this.config.attributedSessionId }
              : {}),
          },
          body:
            options.body === undefined ? undefined : JSON.stringify(options.body),
          signal: controller.signal,
        });

        const payload = await readJsonResponse(response);
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          const error = new ConductorApiError(
            conductorApiErrorMessage(payload, response.status),
            response.status,
            retryable
          );
          if (!retryable || attempt + 1 >= attempts) {
            throw error;
          }
          lastError = error;
          await delay(retryDelayMs(response, attempt));
          continue;
        }

        const parsed = schema.safeParse(payload);
        if (!parsed.success) {
          throw new ConductorApiError(
            `Conductor API response did not match its contract: ${parsed.error.issues
              .slice(0, 3)
              .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
              .join("; ")}`,
            response.status
          );
        }
        return parsed.data;
      } catch (error) {
        const normalized =
          error instanceof ConductorApiError
            ? error
            : (error as Error)?.name === "AbortError"
              ? new ConductorApiError(
                  "Conductor API request timed out",
                  null,
                  true
                )
              : new ConductorApiError(
                  `Conductor API request failed: ${(error as Error).message}`,
                  null,
                  true
                );
        if (!normalized.retryable || attempt + 1 >= attempts) {
          throw normalized;
        }
        lastError = normalized;
        await delay(retryDelayMs(null, attempt));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError ?? new ConductorApiError("Conductor API request failed");
  }
}

export function createConductorApiClientFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ConductorApiClient | null {
  const config = conductorApiConfigFromEnv(env);
  return config ? new ConductorApiClient(config) : null;
}

function normalizeApiBaseUrl(raw: string): string {
  // The value may come from CONDUCTOR_API_BASE_URL or, inside a cloud
  // workspace, the injected CONDUCTOR_API_URL — name both so the error
  // points at whichever the operator actually set.
  const sourceVars = "CONDUCTOR_API_BASE_URL / CONDUCTOR_API_URL";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConductorApiError(`${sourceVars} is not a valid URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new ConductorApiError(`${sourceVars} must use http or https`);
  }
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !isLoopback) {
    throw new ConductorApiError(
      `${sourceVars} must use HTTPS except for a loopback development origin`
    );
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, "");
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (normalizedPath && normalizedPath !== "/v0")
  ) {
    throw new ConductorApiError(
      `${sourceVars} must be an HTTP(S) origin, optionally ending in /v0, without credentials, query, or fragment`
    );
  }
  return parsed.origin;
}

function withQuery(
  apiPath: string,
  values: Record<string, string | number | undefined>
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix ? `${apiPath}?${suffix}` : apiPath;
}

function compactObject<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  );
}

function assertApiIdentity(
  kind: string,
  expected: string,
  actual: string
): void {
  if (actual !== expected) {
    throw new ConductorApiError(
      `Conductor API returned mismatched ${kind} identity`
    );
  }
}

function assertMessageMembership(
  sessionId: string,
  messages: ConductorApiMessage[]
): void {
  if (messages.some((message) => message.sessionId !== sessionId)) {
    throw new ConductorApiError(
      "Conductor API returned a message from a different session"
    );
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ConductorApiError(
      `Conductor API returned non-JSON (HTTP ${response.status})`,
      response.status,
      isRetryableStatus(response.status)
    );
  }
}

function conductorApiErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === "object") {
    const object = payload as Record<string, unknown>;
    for (const key of ["userMessage", "message", "error", "detail"]) {
      if (typeof object[key] === "string" && object[key]) {
        return `Conductor API request failed: ${object[key].slice(0, 500)}`;
      }
    }
  }
  return `Conductor API request failed: HTTP ${status}`;
}

function isRetryableStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 5_000);
  }
  return Math.min(250 * 2 ** attempt, 2_000);
}

function parsePositiveInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConductorApiError(`${name} must be a positive integer`);
  }
  return value;
}

function parseNonnegativeInteger(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConductorApiError(`${name} must be a nonnegative integer`);
  }
  return value;
}
