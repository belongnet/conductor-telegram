import { createHash } from "node:crypto";
import {
  summarizeChecks,
  type GithubCommitChecksSnapshot,
  type GithubPrPolicySnapshot,
} from "./github.js";
import type { CheckObservation } from "../lanes/check-evidence.js";
import type { PrChecksStatus } from "../types/index.js";

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

type GitlabPipeline = {
  id?: number;
  sha?: string;
  ref?: string;
  status?: string;
  source?: string;
  tag?: boolean;
};

// Only a pipeline the project's own CI configuration ran for a push or a
// merge request proves a commit. An external pipeline holds only commit
// statuses that anyone with Developer access can post, a child pipeline is a
// slice of its parent, and a pipeline started by hand, by API, trigger or
// schedule can carry variables that change which jobs run.
const CANONICAL_PIPELINE_SOURCES = new Set([
  "push",
  "merge_request_event",
  "external_pull_request_event",
]);
// Newest first, a page at a time, until a pipeline that counts turns up.
const PIPELINE_PAGE_SIZE = 100;
const MAX_PIPELINE_PAGES = 20;
// The pipeline list does not say whether a pipeline ran for a tag, so each
// candidate is read in full. Past this many tag pipelines the gate waits.
const MAX_PIPELINE_READS = 10;

type GitlabJob = {
  id?: number;
  name?: string;
  status?: string;
  allow_failure?: boolean;
};

/**
 * Only success passes and only failed asks for a repair. Skipped, manual,
 * canceled and every unfinished state hold the gate: a canceled pipeline says
 * nothing about the code, often only that a newer push superseded it.
 */
function pipelineStatus(value: string | undefined): PrChecksStatus {
  const status = String(value ?? "").toLowerCase();
  if (status === "success") return "passing";
  if (status === "failed") return "failing";
  return "pending";
}

/**
 * A job weighed as GitLab weighs it for its pipeline: skipped passes, and a
 * job allowed to fail passes failed, canceled or waiting on a manual start.
 */
function jobStatus(job: GitlabJob): PrChecksStatus {
  const status = String(job.status ?? "").toLowerCase();
  if (status === "skipped") return "passing";
  if (job.allow_failure === true && ["failed", "canceled", "manual"].includes(status)) {
    return "passing";
  }
  return pipelineStatus(status);
}

/**
 * The last run of each job, retried runs included. A commit status posted
 * under a job's name retires that job without ever listing among the jobs,
 * so it can rewrite the pipeline's verdict but not its jobs' last runs.
 */
function lastJobRuns(jobs: readonly GitlabJob[]): Array<GitlabJob & { id: number; name: string }> {
  const last = new Map<string, GitlabJob & { id: number; name: string }>();
  for (const job of jobs) {
    const name = String(job.name ?? "").trim();
    if (!name || !Number.isSafeInteger(job.id) || job.id! <= 0) {
      throw new GitlabApiError("GitLab returned a job without an id or name", 200, false);
    }
    const seen = last.get(name);
    if (!seen || job.id! > seen.id) last.set(name, { ...job, id: job.id!, name });
  }
  return [...last.values()];
}

function namesOf(jobs: ReadonlyArray<{ name: string }>): string {
  const shown = jobs.slice(0, 5).map((job) => job.name).join(", ");
  return jobs.length > 5 ? `${shown} and ${jobs.length - 5} more` : shown;
}

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

/**
 * The commit a merge left at the tip of the target branch, which is the one
 * its branch pipeline runs for. A squash merge under the merge-commit or
 * semi-linear method records both a squash commit and the merge commit on top
 * of it; only a fast-forward squash leaves the squash commit at the tip.
 */
function mergedTip(mergeRequest: GitlabMergeRequest): string | null {
  return (
    mergeRequest.merge_commit_sha?.toLowerCase() ??
    mergeRequest.squash_commit_sha?.toLowerCase() ??
    null
  );
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

  private projectPath(identity: Pick<GitlabMrIdentity, "project">): string {
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
      mergeCommitSha: mergedTip(mergeRequest),
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
      checks: statuses
        .map((status) => ({
          name: String(status.name ?? "").trim(),
          status: summarizeChecks([statusAsRollup(status)]).status,
        }))
        .filter((status) => Boolean(status.name)),
    };
  }

  /**
   * The newest pipeline the canonical project ran for one exact commit, with
   * the last run of each of its jobs. `ref` pins a merged commit to the
   * canonical branch's own pipeline. The pipeline passes only when GitLab
   * says it succeeded and every job's last run agrees; named checks pass only
   * on a job's successful last run.
   */
  async commitPipeline(input: {
    projectPath: string;
    sha: string;
    ref?: string;
    baseBranch?: string;
    expectedMrIid?: number;
  }): Promise<CheckObservation> {
    const sha = input.sha.toLowerCase();
    if (!GIT_OID_RE.test(sha)) throw new Error("GitLab pipeline evidence requires a full SHA");
    const identity = { baseUrl: "https://gitlab.com", project: input.projectPath };
    const canonical = (pipeline: GitlabPipeline) =>
      Number.isSafeInteger(pipeline.id) &&
      pipeline.id! > 0 &&
      pipeline.sha?.toLowerCase() === sha &&
      CANONICAL_PIPELINE_SOURCES.has(String(pipeline.source ?? ""));
    const mergeRequestIid = (pipeline: GitlabPipeline): number | null => {
      if (pipeline.source !== "merge_request_event" || !input.ref || !input.baseBranch) {
        return null;
      }
      const match = /^refs\/merge-requests\/([1-9]\d*)\/head$/.exec(pipeline.ref ?? "");
      const iid = Number(match?.[1]);
      return match && Number.isSafeInteger(iid) &&
        (input.expectedMrIid === undefined || iid === input.expectedMrIid)
        ? iid
        : null;
    };
    const possibleRef = (pipeline: GitlabPipeline) =>
      !input.ref || pipeline.ref === input.ref || mergeRequestIid(pipeline) !== null;
    const matchesRef = async (pipeline: GitlabPipeline): Promise<boolean> => {
      if (!input.ref || pipeline.ref === input.ref) return true;
      const iid = mergeRequestIid(pipeline);
      if (iid === null) return false;
      let mr: GitlabMergeRequest;
      try {
        mr = await this.request<GitlabMergeRequest>(
          identity,
          "GET",
          `${this.projectPath(identity)}/merge_requests/${iid}`
        );
      } catch (error) {
        if (error instanceof GitlabApiError && error.status === 404) return false;
        throw error;
      }
      return (
        mr.iid === iid &&
        mr.state === "opened" &&
        mr.source_branch === input.ref &&
        mr.target_branch === input.baseBranch &&
        mr.sha?.toLowerCase() === sha
      );
    };
    const query = new URLSearchParams({
      sha,
      order_by: "id",
      sort: "desc",
      per_page: String(PIPELINE_PAGE_SIZE),
    });
    // The merged commit only accepts the canonical branch. A reviewed head
    // also accepts an MR ref after the MR's branch, target and SHA are bound.
    if (input.ref && !input.baseBranch) query.set("ref", input.ref);
    let latest: GitlabPipeline | undefined;
    let reads = 0;
    let cutShort: string | null = null;
    let page = "1";
    pages: for (let read = 0; ; read += 1) {
      if (read >= MAX_PIPELINE_PAGES) {
        cutShort = `${MAX_PIPELINE_PAGES} pages of pipelines`;
        break;
      }
      query.set("page", page);
      const response = await this.requestPage<GitlabPipeline[]>(
        identity,
        "GET",
        `${this.projectPath(identity)}/pipelines?${query}`
      );
      if (!Array.isArray(response.payload)) {
        throw new GitlabApiError("GitLab pipeline list was not an array", 200, false);
      }
      const candidates = response.payload
        .filter((pipeline) => canonical(pipeline) && possibleRef(pipeline) && pipeline.tag !== true)
        .sort((left, right) => right.id! - left.id!);
      for (const candidate of candidates) {
        if (reads >= MAX_PIPELINE_READS) {
          cutShort = `${MAX_PIPELINE_READS} tag pipelines`;
          break pages;
        }
        reads += 1;
        const detail = await this.request<GitlabPipeline>(
          identity,
          "GET",
          `${this.projectPath(identity)}/pipelines/${candidate.id}`
        );
        if (
          detail.id !== candidate.id ||
          !canonical(detail) ||
          !possibleRef(detail) ||
          typeof detail.tag !== "boolean"
        ) {
          throw new GitlabApiError(
            `GitLab pipeline ${candidate.id} did not match its list entry when read in full`,
            200,
            false
          );
        }
        if (!detail.tag && await matchesRef(detail)) {
          latest = detail;
          break pages;
        }
      }
      if (!response.nextPage) break;
      if (!/^\d+$/.test(response.nextPage) || Number(response.nextPage) <= Number(page)) {
        throw new GitlabApiError("GitLab returned an invalid pagination cursor", 200, false);
      }
      page = response.nextPage;
    }
    const observed = {
      source: "gitlab" as const,
      projectPath: input.projectPath.toLowerCase(),
      sha,
    };
    if (!latest) {
      return {
        ...observed,
        pipelineId: null,
        status: "pending",
        // A search cut short never claims that no pipeline exists.
        summary: cutShort
          ? `GitLab pipeline search for ${sha.slice(0, 12)} stopped after ${cutShort}`
          : `no GitLab pipeline for ${sha.slice(0, 12)}${reads > 0 ? " besides tag pipelines" : ""}`,
        checks: [],
      };
    }
    const pipelinePath = `${this.projectPath(identity)}/pipelines/${latest.id}`;
    // A push can supply ci.variable options while still reporting source=push.
    // Those variables can change which jobs the project's CI configuration runs.
    const variables = await this.request<unknown>(identity, "GET", `${pipelinePath}/variables`);
    if (!Array.isArray(variables)) {
      throw new GitlabApiError("GitLab pipeline variables were not an array", 200, false);
    }
    if (variables.length > 0) {
      return {
        ...observed,
        pipelineId: latest.id!,
        status: "pending",
        summary: `GitLab pipeline ${latest.id} supplied variables; CI evidence is untrusted`,
        checks: [],
      };
    }
    const [jobs, bridges] = await Promise.all([
      this.paginated<GitlabJob>(identity, `${pipelinePath}/jobs?include_retried=true`),
      this.paginated<GitlabJob>(identity, `${pipelinePath}/bridges`),
    ]);
    const runs = lastJobRuns([...jobs, ...bridges]);
    const failed = runs.filter((job) => jobStatus(job) === "failing");
    const waiting = runs.filter((job) => jobStatus(job) === "pending");
    const verdict = pipelineStatus(latest.status);
    const status: PrChecksStatus =
      verdict === "failing" || failed.length > 0
        ? "failing"
        : verdict === "passing" && runs.length > 0 && waiting.length === 0
          ? "passing"
          : "pending";
    const why =
      failed.length > 0
        ? `; jobs failed: ${namesOf(failed)}`
        : verdict === "passing" && waiting.length > 0
          ? `; jobs not finished: ${namesOf(waiting)}`
          : runs.length === 0
            ? "; no jobs"
            : "";
    return {
      ...observed,
      pipelineId: latest.id!,
      status,
      summary: `GitLab pipeline ${latest.id} ${latest.status ?? "unknown"}${why}`,
      checks: runs.map((job) => ({
        name: job.name,
        status: pipelineStatus(job.status),
        id: `gitlab-job-${job.id}`,
      })),
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
    expectedHeadBranch: string;
    expectedBaseBranch: string;
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
      before.source_branch !== input.expectedHeadBranch ||
      before.target_branch !== input.expectedBaseBranch ||
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
    const mergedSha = mergedTip(after);
    if (
      after.state !== "merged" ||
      after.sha?.toLowerCase() !== input.expectedHeadSha.toLowerCase() ||
      after.source_branch !== input.expectedHeadBranch ||
      after.target_branch !== input.expectedBaseBranch ||
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
      "Manifest requires GitLab delivery or canonical GitLab evidence but GITLAB_TOKEN is missing; add one read_api/api-capable token"
    );
  }
  return new GitlabLaneGateway(token);
}
