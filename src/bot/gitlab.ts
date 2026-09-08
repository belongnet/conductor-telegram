import { createHash } from "node:crypto";
import {
  summarizeChecks,
  type GithubCommitChecksSnapshot,
  type GithubPrPolicySnapshot,
} from "./github.js";

const GIT_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export type GitlabMrIdentity = {
  baseUrl: string;
  owner: string;
  repo: string;
  project: string;
  number: number;
};

export function gitlabMrIdentity(mrUrl: string): GitlabMrIdentity | null {
  try {
    const parsed = new URL(mrUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "gitlab.com" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname.includes("%")
    ) {
      return null;
    }
    const parts = parsed.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const marker = parts.lastIndexOf("-");
    if (
      marker < 2 ||
      parts[marker + 1] !== "merge_requests" ||
      !/^\d+$/.test(parts[marker + 2] ?? "") ||
      marker + 3 !== parts.length
    ) {
      return null;
    }
    const projectParts = parts.slice(0, marker);
    const repo = projectParts.at(-1)!;
    const owner = projectParts.slice(0, -1).join("/");
    const number = Number(parts[marker + 2]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return {
      baseUrl: `${parsed.protocol}//${parsed.host}`,
      owner: owner.toLowerCase(),
      repo: repo.replace(/\.git$/i, "").toLowerCase(),
      project: [...projectParts.slice(0, -1), repo.replace(/\.git$/i, "")].join("/"),
      number,
    };
  } catch {
    return null;
  }
}

type GitlabMergeRequest = {
  iid?: number;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  web_url?: string;
};

type GitlabStatus = {
  name?: string;
  status?: string;
};

type GitlabNote = {
  id?: number;
  body?: string;
  created_at?: string;
};

export class GitlabApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = "GitlabApiError";
  }
}

function statusAsRollup(status: GitlabStatus): Record<string, string> {
  const value = String(status.status ?? "").toLowerCase();
  const conclusion = ["success", "success_with_warnings", "skipped"].includes(value)
    ? "SUCCESS"
    : ["failed", "canceled"].includes(value)
      ? "FAILURE"
      : "";
  return {
    status: conclusion ? "COMPLETED" : "IN_PROGRESS",
    conclusion,
  };
}

function markerHeadSha(body: string): string | null {
  const match = body.match(/"headSha"\s*:\s*"([0-9a-f]{40}(?:[0-9a-f]{24})?)"/i);
  return match?.[1]?.toLowerCase() ?? null;
}

export class GitlabLaneGateway {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch
  ) {
    if (!token.trim()) throw new Error("GITLAB_TOKEN is required for GitLab lane delivery");
  }

  private async requestPage<T>(
    identity: Pick<GitlabMrIdentity, "baseUrl">,
    method: "GET" | "POST" | "PUT",
    apiPath: string,
    body?: Record<string, unknown>
  ): Promise<{ payload: T; nextPage: string | null }> {
    let response: Response;
    try {
      response = await this.fetcher(`${identity.baseUrl}/api/v4${apiPath}`, {
        method,
        redirect: "error",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "PRIVATE-TOKEN": this.token,
          "User-Agent": "conductor-telegram-lanes",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new GitlabApiError(
        `GitLab request failed: ${error instanceof Error ? error.message : error}`,
        null,
        true
      );
    }
    const text = await response.text();
    let payload: unknown = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new GitlabApiError("GitLab returned malformed JSON", response.status, false);
      }
    }
    if (!response.ok) {
      const detail =
        payload && typeof payload === "object" && "message" in payload
          ? JSON.stringify((payload as Record<string, unknown>).message)
          : text.slice(0, 300);
      throw new GitlabApiError(
        `GitLab HTTP ${response.status}: ${detail}`,
        response.status,
        response.status === 429 || response.status >= 500
      );
    }
    return {
      payload: payload as T,
      nextPage: response.headers.get("x-next-page")?.trim() || null,
    };
  }

  private async request<T>(
    identity: Pick<GitlabMrIdentity, "baseUrl">,
    method: "GET" | "POST" | "PUT",
    apiPath: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    return (await this.requestPage<T>(identity, method, apiPath, body)).payload;
  }

  private async paginated<T>(
    identity: Pick<GitlabMrIdentity, "baseUrl">,
    apiPath: string
  ): Promise<T[]> {
    const results: T[] = [];
    let page = "1";
    for (let requestCount = 0; requestCount < 100; requestCount += 1) {
      const separator = apiPath.includes("?") ? "&" : "?";
      const response = await this.requestPage<T[]>(
        identity,
        "GET",
        `${apiPath}${separator}per_page=100&page=${encodeURIComponent(page)}`
      );
      if (!Array.isArray(response.payload)) {
        throw new GitlabApiError("GitLab paginated response was not an array", 200, false);
      }
      results.push(...response.payload);
      if (!response.nextPage) return results;
      if (!/^\d+$/.test(response.nextPage) || Number(response.nextPage) <= Number(page)) {
        throw new GitlabApiError("GitLab returned an invalid pagination cursor", 200, false);
      }
      page = response.nextPage;
    }
    throw new GitlabApiError("GitLab pagination exceeded 100 pages", 200, false);
  }

  private projectPath(identity: GitlabMrIdentity): string {
    return `/projects/${encodeURIComponent(identity.project)}`;
  }

  private async statuses(identity: GitlabMrIdentity, sha: string): Promise<GitlabStatus[]> {
    return this.paginated<GitlabStatus>(
      identity,
      `${this.projectPath(identity)}/repository/commits/${encodeURIComponent(sha)}/statuses`
    );
  }

  private async notes(identity: GitlabMrIdentity): Promise<GitlabNote[]> {
    return this.paginated<GitlabNote>(
      identity,
      `${this.projectPath(identity)}/merge_requests/${identity.number}/notes?sort=asc`
    );
  }

  async refreshPr(prUrl: string): Promise<GithubPrPolicySnapshot> {
    const identity = gitlabMrIdentity(prUrl);
    if (!identity) throw new Error("GitLab delivery requires a canonical merge-request URL");
    const mergeRequest = await this.request<GitlabMergeRequest>(
      identity,
      "GET",
      `${this.projectPath(identity)}/merge_requests/${identity.number}`
    );
    if (!mergeRequest.sha || !GIT_OID_RE.test(mergeRequest.sha)) {
      throw new Error("GitLab merge request is missing a full head SHA");
    }
    const [statuses, notes] = await Promise.all([
      this.statuses(identity, mergeRequest.sha),
      this.notes(identity),
    ]);
    const rollup = statuses.map(statusAsRollup);
    const checks = summarizeChecks(rollup);
    const mergeable =
      mergeRequest.merge_status === "can_be_merged" ||
      mergeRequest.detailed_merge_status === "mergeable";
    return {
      url: mergeRequest.web_url ?? prUrl,
      repoOwner: identity.owner,
      repoName: identity.repo,
      prNumber: mergeRequest.iid ?? identity.number,
      state:
        mergeRequest.state === "opened"
          ? "open"
          : mergeRequest.state === "merged"
            ? "merged"
            : mergeRequest.state === "closed"
              ? "closed"
              : "unknown",
      isDraft: Boolean(mergeRequest.draft ?? mergeRequest.work_in_progress),
      headBranch: mergeRequest.source_branch ?? null,
      baseBranch: mergeRequest.target_branch ?? null,
      headSha: mergeRequest.sha.toLowerCase(),
      reviewDecision: null,
      mergeStateStatus: mergeable ? "CLEAN" : mergeRequest.detailed_merge_status ?? null,
      mergeable: mergeable ? "MERGEABLE" : "UNKNOWN",
      checksStatus: checks.status,
      checksSummary: checks.summary,
      checks: statuses
        .map((status) => ({
          name: String(status.name ?? "").trim(),
          status: summarizeChecks([statusAsRollup(status)]).status,
        }))
        .filter((status) => Boolean(status.name)),
      mergeCommitSha:
        mergeRequest.squash_commit_sha?.toLowerCase() ??
        mergeRequest.merge_commit_sha?.toLowerCase() ??
        null,
      reviews: notes
        .filter((note) => Boolean(note.body))
        .map((note) => ({
          body: note.body ?? "",
          state: "COMMENTED",
          submittedAt: note.created_at ?? "",
          commitSha: markerHeadSha(note.body ?? ""),
        })),
    };
  }

  async refreshCommitChecks(input: {
    repoOwner: string;
    repoName: string;
    sha: string;
  }): Promise<GithubCommitChecksSnapshot> {
    if (!GIT_OID_RE.test(input.sha)) throw new Error("GitLab checks require a full SHA");
    const identity: GitlabMrIdentity = {
      baseUrl: "https://gitlab.com",
      owner: input.repoOwner.toLowerCase(),
      repo: input.repoName.toLowerCase(),
      project: `${input.repoOwner}/${input.repoName}`,
      number: 0,
    };
    const statuses = await this.statuses(identity, input.sha.toLowerCase());
    const summary = summarizeChecks(statuses.map(statusAsRollup));
    return {
      repoOwner: identity.owner,
      repoName: identity.repo,
      sha: input.sha.toLowerCase(),
      status: summary.status,
      summary: summary.summary,
    };
  }

  async postReview(prUrl: string, body: string, expectedHeadSha: string) {
    const identity = gitlabMrIdentity(prUrl);
    if (!identity || !GIT_OID_RE.test(expectedHeadSha)) {
      throw new Error("GitLab review requires a canonical MR and full expected head SHA");
    }
    const endpoint = `${this.projectPath(identity)}/merge_requests/${identity.number}`;
    const before = await this.request<GitlabMergeRequest>(identity, "GET", endpoint);
    if (before.sha?.toLowerCase() !== expectedHeadSha.toLowerCase()) {
      throw new Error("GitLab merge-request head changed before review publication");
    }
    const note = await this.request<GitlabNote>(
      identity,
      "POST",
      `${this.projectPath(identity)}/merge_requests/${identity.number}/notes`,
      { body }
    );
    const after = await this.request<GitlabMergeRequest>(identity, "GET", endpoint);
    if (
      after.sha?.toLowerCase() !== expectedHeadSha.toLowerCase() ||
      note.body !== body ||
      !note.id
    ) {
      throw new Error("GitLab review receipt did not match its body and exact head");
    }
    return { reviewId: String(note.id), body, commitSha: expectedHeadSha.toLowerCase() };
  }

  async postComment(prUrl: string, body: string): Promise<void> {
    const identity = gitlabMrIdentity(prUrl);
    if (!identity) throw new Error("GitLab comment requires a canonical MR URL");
    await this.request(
      identity,
      "POST",
      `${this.projectPath(identity)}/merge_requests/${identity.number}/notes`,
      { body }
    );
  }

  async hasCommentTag(
    prUrl: string,
    tag: string,
    expectedBodyHash?: string
  ): Promise<boolean> {
    const identity = gitlabMrIdentity(prUrl);
    if (!identity) throw new Error("GitLab comment lookup requires a canonical MR URL");
    return (await this.notes(identity)).some((note) => {
      const body = note.body ?? "";
      return (
        body.includes(tag) &&
        (!expectedBodyHash ||
          createHash("sha256").update(body).digest("hex") === expectedBodyHash)
      );
    });
  }

  async merge(input: {
    prUrl: string;
    method: "squash" | "merge" | "rebase";
    expectedHeadSha: string;
  }): Promise<{ mergedSha: string }> {
    const identity = gitlabMrIdentity(input.prUrl);
    if (!identity || !GIT_OID_RE.test(input.expectedHeadSha)) {
      throw new Error("GitLab merge requires a canonical MR and full expected head SHA");
    }
    if (input.method === "rebase") {
      throw new Error("GitLab lane delivery does not support controller-initiated rebases");
    }
    const endpoint = `${this.projectPath(identity)}/merge_requests/${identity.number}`;
    const before = await this.request<GitlabMergeRequest>(identity, "GET", endpoint);
    const mergeable =
      before.merge_status === "can_be_merged" ||
      before.detailed_merge_status === "mergeable";
    if (
      before.sha?.toLowerCase() !== input.expectedHeadSha.toLowerCase() ||
      before.state !== "opened" ||
      !mergeable
    ) {
      throw new Error("GitLab merge gate changed before exact-head merge");
    }
    await this.request<GitlabMergeRequest>(
      identity,
      "PUT",
      `${endpoint}/merge`,
      {
        sha: input.expectedHeadSha.toLowerCase(),
        squash: input.method === "squash",
        should_remove_source_branch: false,
      }
    );
    const after = await this.request<GitlabMergeRequest>(identity, "GET", endpoint);
    const mergedSha =
      after.squash_commit_sha?.toLowerCase() ??
      after.merge_commit_sha?.toLowerCase() ??
      null;
    if (
      after.state !== "merged" ||
      after.sha?.toLowerCase() !== input.expectedHeadSha.toLowerCase() ||
      !mergedSha ||
      !GIT_OID_RE.test(mergedSha)
    ) {
      throw new Error("GitLab merge response was ambiguous; merged state is not proven");
    }
    return { mergedSha };
  }
}

export function gitlabLaneGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env
): GitlabLaneGateway {
  const token = env.GITLAB_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "Manifest requires GitLab delivery but GITLAB_TOKEN is missing; add one read_api/api-capable token"
    );
  }
  return new GitlabLaneGateway(token);
}
