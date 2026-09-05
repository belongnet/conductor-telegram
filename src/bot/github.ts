import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { PrChecksStatus, PrRecord, PrState, Workspace } from "../types/index.js";
import { upsertPrRecord } from "../store/queries.js";
import { getWorkspaceBranchName } from "./launcher.js";

const COMMAND_TIMEOUT_MS = 30_000;
const GIT_OID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface GithubPrJson {
  number?: number;
  title?: string;
  url?: string;
  state?: string;
  isDraft?: boolean;
  headRefName?: string;
  headRefOid?: string;
  baseRefName?: string;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  mergeable?: string | null;
  statusCheckRollup?: Array<{
    name?: string | null;
    context?: string | null;
    state?: string | null;
    status?: string | null;
    conclusion?: string | null;
  }>;
  mergeCommit?: { oid?: string } | null;
  reviews?: Array<{
    body?: string;
    state?: string;
    submittedAt?: string;
    commit?: { oid?: string } | null;
  }>;
}

interface GithubReviewApiJson {
  body?: string | null;
  state?: string | null;
  submitted_at?: string | null;
  commit_id?: string | null;
}

interface GithubIssueCommentApiJson {
  body?: string | null;
}

export interface GithubPrReviewSnapshot {
  body: string;
  state: string;
  submittedAt: string;
  commitSha: string | null;
}

export interface GithubPrReviewReceipt {
  reviewId: string;
  body: string;
  commitSha: string;
}

export interface ExactHeadReviewRequest {
  args: string[];
  stdin: string;
}

export interface GithubPrPolicySnapshot {
  url: string;
  repoOwner: string | null;
  repoName: string | null;
  prNumber: number | null;
  state: PrState;
  isDraft: boolean;
  headBranch: string | null;
  baseBranch: string | null;
  headSha: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  checksStatus: PrChecksStatus;
  checksSummary: string;
  checks?: Array<{ name: string; status: PrChecksStatus }>;
  mergeCommitSha: string | null;
  reviews: GithubPrReviewSnapshot[];
}

export interface GithubCommitChecksSnapshot {
  repoOwner: string;
  repoName: string;
  sha: string;
  status: PrChecksStatus;
  summary: string;
}

export interface PrRefreshResult {
  record: PrRecord;
  repoSlug: string | null;
}

export type RequiredChecksGate = {
  passing: boolean;
  missing: string[];
  notPassing: string[];
  pending: string[];
  failed: string[];
};

export function requiredChecksGate(
  policy: Pick<GithubPrPolicySnapshot, "checksStatus" | "checks">,
  requiredChecks: readonly string[]
): RequiredChecksGate {
  const observed = new Map<string, PrChecksStatus>();
  const severity: Record<PrChecksStatus, number> = {
    unknown: 2,
    pending: 2,
    passing: 1,
    failing: 3,
  };
  for (const check of policy.checks ?? []) {
    const name = check.name.toLowerCase();
    const prior = observed.get(name);
    if (!prior || severity[check.status] > severity[prior]) {
      observed.set(name, check.status);
    }
  }
  const missing = requiredChecks.filter(
    (name) => !observed.has(name.toLowerCase())
  );
  const failed = requiredChecks.filter(
    (name) => observed.get(name.toLowerCase()) === "failing"
  );
  const pending = requiredChecks.filter((name) => {
    const status = observed.get(name.toLowerCase());
    return status === "pending" || status === "unknown";
  });
  const notPassing = requiredChecks.filter(
    (name) => failed.includes(name) || pending.includes(name)
  );
  return {
    // The manifest names the checks that are merge gates. Optional checks in
    // the host-wide rollup must not silently become required, and an empty
    // required-check profile is satisfied vacuously. Git-host mergeability is
    // still enforced independently immediately before the exact-head merge.
    passing: missing.length === 0 && notPassing.length === 0,
    missing,
    notPassing,
    pending,
    failed,
  };
}

export function workspaceBranch(workspace: Workspace): string | null {
  if (!workspace.conductorWorkspaceName) return null;
  return (
    getWorkspaceBranchName(workspace.conductorWorkspaceName, workspace.repoPath) ??
    `belongcond/${workspace.conductorWorkspaceName}`
  );
}

export function canMergePr(
  record: Pick<
    PrRecord,
    | "state"
    | "isDraft"
    | "prNumber"
    | "headSha"
    | "reviewDecision"
    | "checksStatus"
    | "mergeable"
    | "mergeStateStatus"
  >,
  options: { attestedApproval?: boolean } = {},
): boolean {
  if (record.state !== "open") return false;
  if (record.isDraft) return false;
  if (!record.prNumber || !Number.isInteger(record.prNumber)) return false;
  if (!record.headSha || !GIT_OID_RE.test(record.headSha)) return false;
  // GitHub collapses same-account COMMENTED reviews into a null aggregate
  // decision. The lane controller supplies stronger nonce/head-bound
  // attestations; ordinary Telegram merges still require GitHub APPROVED.
  if (
    record.reviewDecision?.toUpperCase() !== "APPROVED" &&
    options.attestedApproval !== true
  ) {
    return false;
  }
  if (record.checksStatus !== "passing") return false;
  if (record.mergeable?.toUpperCase() !== "MERGEABLE") return false;
  const mergeState = record.mergeStateStatus?.toUpperCase() ?? "";
  return mergeState === "CLEAN" || mergeState === "HAS_HOOKS";
}

export async function refreshPrByUrl(
  prUrl: string,
): Promise<GithubPrPolicySnapshot> {
  const result = await runGh([
    "pr",
    "view",
    prUrl,
    "--json",
    [
      "url",
      "number",
      "state",
      "isDraft",
      "headRefName",
      "baseRefName",
      "headRefOid",
      "reviewDecision",
      "mergeStateStatus",
      "mergeable",
      "statusCheckRollup",
      "mergeCommit",
      "reviews",
    ].join(","),
  ]);
  if (result.code !== 0) {
    throw new Error(`Could not refresh ${prUrl}: ${compactError(result)}`);
  }
  let pr: GithubPrJson;
  try {
    pr = JSON.parse(result.stdout) as GithubPrJson;
  } catch {
    throw new Error(`GitHub returned malformed PR JSON for ${prUrl}.`);
  }
  const checks = summarizeChecks(pr.statusCheckRollup ?? []);
  const identity = githubPrIdentity(pr.url ?? prUrl);
  const reviews = identity
    ? await refreshPrReviews(identity)
    : (pr.reviews ?? []).map((review) => ({
        body: review.body ?? "",
        state: review.state ?? "",
        submittedAt: review.submittedAt ?? "",
        commitSha: review.commit?.oid?.toLowerCase() ?? null,
      }));
  return {
    url: pr.url ?? prUrl,
    repoOwner: identity?.owner ?? null,
    repoName: identity?.repo ?? null,
    prNumber: pr.number ?? null,
    state: normalizePrState(pr.state),
    isDraft: Boolean(pr.isDraft),
    headBranch: pr.headRefName ?? null,
    baseBranch: pr.baseRefName ?? null,
    headSha: pr.headRefOid ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    mergeable: pr.mergeable ?? null,
    checksStatus: checks.status,
    checksSummary: checks.summary,
    checks: (pr.statusCheckRollup ?? [])
      .map((check) => ({
        name: String(check.name ?? check.context ?? "").trim(),
        status: summarizeChecks([check]).status,
      }))
      .filter((check) => Boolean(check.name)),
    mergeCommitSha: pr.mergeCommit?.oid?.toLowerCase() ?? null,
    reviews,
  };
}

async function refreshPrReviews(identity: {
  owner: string;
  repo: string;
  number: number;
}): Promise<GithubPrReviewSnapshot[]> {
  const result = await runGh([
    "api",
    `repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/reviews`,
    "--method",
    "GET",
    "-f",
    "per_page=100",
    "--paginate",
    "--slurp",
  ]);
  if (result.code !== 0) {
    throw new Error(`Could not refresh paginated PR reviews: ${compactError(result)}`);
  }
  let pages: GithubReviewApiJson[][];
  try {
    const decoded = JSON.parse(result.stdout) as unknown;
    pages = Array.isArray(decoded) && Array.isArray(decoded[0])
      ? (decoded as GithubReviewApiJson[][])
      : [decoded as GithubReviewApiJson[]];
  } catch {
    throw new Error("GitHub returned malformed review JSON.");
  }
  return pages
    .flat()
    .map((review) => ({
      body: review.body ?? "",
      state: review.state ?? "",
      submittedAt: review.submitted_at ?? "",
      commitSha: review.commit_id?.toLowerCase() ?? null,
    }))
    .sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
}

export function githubPrIdentity(
  prUrl: string
): { owner: string; repo: string; number: number } | null {
  try {
    const parsed = new URL(prUrl);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.toLowerCase() !== "github.com" ||
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
    if (
      parts.length !== 4 ||
      parts[2] !== "pull" ||
      !/^\d+$/.test(parts[3])
    ) {
      return null;
    }
    const number = Number(parts[3]);
    if (!Number.isSafeInteger(number) || number < 1) return null;
    return {
      owner: parts[0].toLowerCase(),
      repo: parts[1].replace(/\.git$/i, "").toLowerCase(),
      number,
    };
  } catch {
    return null;
  }
}

export async function refreshCommitChecks(input: {
  repoOwner: string;
  repoName: string;
  sha: string;
}): Promise<GithubCommitChecksSnapshot> {
  if (!GIT_OID_RE.test(input.sha)) {
    throw new Error("Commit checks require a full Git object ID.");
  }
  const owner = input.repoOwner.toLowerCase();
  const repo = input.repoName.toLowerCase();
  const [checkResult, statusResult] = await Promise.all([
    runGh([
      "api",
      `repos/${owner}/${repo}/commits/${input.sha.toLowerCase()}/check-runs`,
      "--method",
      "GET",
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp",
    ]),
    runGh([
      "api",
      `repos/${owner}/${repo}/commits/${input.sha.toLowerCase()}/status`,
      "--method",
      "GET",
      "-f",
      "per_page=100",
      "--paginate",
      "--slurp",
    ]),
  ]);
  if (checkResult.code !== 0 || statusResult.code !== 0) {
    throw new Error(
      `Could not refresh checks for ${owner}/${repo}@${input.sha}: ` +
        compactError(checkResult.code !== 0 ? checkResult : statusResult)
    );
  }
  let checkPages: Array<{ check_runs?: unknown[] }>;
  let statusPages: Array<{ statuses?: unknown[] }>;
  try {
    const decodedChecks = JSON.parse(checkResult.stdout) as unknown;
    const decodedStatuses = JSON.parse(statusResult.stdout) as unknown;
    checkPages = Array.isArray(decodedChecks)
      ? (decodedChecks as Array<{ check_runs?: unknown[] }>)
      : [decodedChecks as { check_runs?: unknown[] }];
    statusPages = Array.isArray(decodedStatuses)
      ? (decodedStatuses as Array<{ statuses?: unknown[] }>)
      : [decodedStatuses as { statuses?: unknown[] }];
  } catch {
    throw new Error("GitHub returned malformed commit-check JSON.");
  }
  const checks = summarizeChecks(
    [
      ...checkPages.flatMap((page) => page.check_runs ?? []),
      ...statusPages.flatMap((page) => page.statuses ?? []),
    ]
  );
  return {
    repoOwner: owner,
    repoName: repo,
    sha: input.sha.toLowerCase(),
    status: checks.status,
    summary: checks.summary,
  };
}

export async function postPrReviewComment(
  prUrl: string,
  body: string,
  expectedHeadSha: string
): Promise<GithubPrReviewReceipt> {
  const request = buildExactHeadReviewRequest({ prUrl, body, expectedHeadSha });
  const result = await runGh(request.args, { stdin: request.stdin });
  if (result.code !== 0) {
    throw new Error(`Could not post commissioned review: ${compactError(result)}`);
  }
  let receipt: { id?: number | string; body?: string; commit_id?: string };
  try {
    receipt = JSON.parse(result.stdout) as typeof receipt;
  } catch {
    throw new Error("GitHub returned a malformed commissioned-review receipt.");
  }
  if (
    !receipt.id ||
    receipt.body !== body ||
    receipt.commit_id?.toLowerCase() !== expectedHeadSha.toLowerCase()
  ) {
    throw new Error("GitHub commissioned-review receipt did not match its nonce/body/head request.");
  }
  return {
    reviewId: String(receipt.id),
    body,
    commitSha: receipt.commit_id.toLowerCase(),
  };
}

export function buildExactHeadReviewRequest(input: {
  prUrl: string;
  body: string;
  expectedHeadSha: string;
}): ExactHeadReviewRequest {
  const { prUrl, body, expectedHeadSha } = input;
  const identity = githubPrIdentity(prUrl);
  if (!identity) throw new Error("Review requires a canonical GitHub PR URL.");
  if (!GIT_OID_RE.test(expectedHeadSha)) {
    throw new Error("Review requires a full expected Git object ID.");
  }
  return {
    args: [
      "api",
      `repos/${identity.owner}/${identity.repo}/pulls/${identity.number}/reviews`,
      "--method",
      "POST",
      "--input",
      "-",
    ],
    stdin: JSON.stringify({
      event: "COMMENT",
      commit_id: expectedHeadSha.toLowerCase(),
      body,
    }),
  };
}

export async function postPrComment(
  prUrl: string,
  body: string
): Promise<void> {
  if (!githubPrIdentity(prUrl)) {
    throw new Error("Comment requires a canonical GitHub PR URL.");
  }
  const result = await runGh(["pr", "comment", prUrl, "--body", body]);
  if (result.code !== 0) {
    throw new Error(`Could not post PR comment: ${compactError(result)}`);
  }
}

export async function prHasCommentTag(
  prUrl: string,
  tag: string,
  expectedBodyHash?: string
): Promise<boolean> {
  const identity = githubPrIdentity(prUrl);
  if (!identity) throw new Error("Comment lookup requires a canonical GitHub PR URL.");
  const result = await runGh([
    "api",
    `repos/${identity.owner}/${identity.repo}/issues/${identity.number}/comments`,
    "--method",
    "GET",
    "-f",
    "per_page=100",
    "--paginate",
    "--slurp",
  ]);
  if (result.code !== 0) {
    throw new Error(`Could not reconcile PR comments: ${compactError(result)}`);
  }
  let pages: GithubIssueCommentApiJson[][];
  try {
    const decoded = JSON.parse(result.stdout) as unknown;
    pages = Array.isArray(decoded) && Array.isArray(decoded[0])
      ? (decoded as GithubIssueCommentApiJson[][])
      : [decoded as GithubIssueCommentApiJson[]];
  } catch {
    throw new Error("GitHub returned malformed issue-comment JSON.");
  }
  return pages.flat().some((comment) => {
    const body = comment.body ?? "";
    return (
      body.includes(tag) &&
      (!expectedBodyHash ||
        createHash("sha256").update(body).digest("hex") === expectedBodyHash)
    );
  });
}

export async function mergePrByUrl(input: {
  prUrl: string;
  method: "squash" | "merge" | "rebase";
  expectedHeadSha: string;
}): Promise<{ mergedSha: string }> {
  if (!githubPrIdentity(input.prUrl)) {
    throw new Error("Merge requires a canonical GitHub PR URL.");
  }
  if (!GIT_OID_RE.test(input.expectedHeadSha)) {
    throw new Error("Merge requires a full expected Git object ID.");
  }
  const methodFlag =
    input.method === "merge"
      ? "--merge"
      : input.method === "rebase"
        ? "--rebase"
        : "--squash";
  const result = await runGh(
    [
      "pr",
      "merge",
      input.prUrl,
      methodFlag,
      "--match-head-commit",
      input.expectedHeadSha.toLowerCase(),
    ],
    { timeoutMs: 15_000 }
  );
  if (result.code !== 0) {
    throw new Error(`GitHub merge did not return success: ${compactError(result)}`);
  }
  const identity = githubPrIdentity(input.prUrl)!;
  const verify = await runGh(
    [
      "api",
      `repos/${identity.owner}/${identity.repo}/pulls/${identity.number}`,
      "--method",
      "GET",
      "--jq",
      "{merged: .merged, merge_commit_sha: .merge_commit_sha, head_sha: .head.sha}",
    ],
    { timeoutMs: 15_000 }
  );
  if (verify.code !== 0) {
    throw new Error(
      `GitHub merge response was ambiguous; verification failed: ${compactError(verify)}`
    );
  }
  let receipt: {
    merged?: boolean;
    merge_commit_sha?: string | null;
    head_sha?: string | null;
  };
  try {
    receipt = JSON.parse(verify.stdout) as typeof receipt;
  } catch {
    throw new Error("GitHub merge response was ambiguous; verification JSON was malformed.");
  }
  if (
    receipt.merged !== true ||
    !receipt.merge_commit_sha ||
    !GIT_OID_RE.test(receipt.merge_commit_sha) ||
    receipt.head_sha?.toLowerCase() !== input.expectedHeadSha.toLowerCase()
  ) {
    throw new Error("GitHub merge response was ambiguous; merged state is not yet proven.");
  }
  return { mergedSha: receipt.merge_commit_sha.toLowerCase() };
}

export function matchesExpectedPrHead(
  record: Pick<PrRecord, "headSha">,
  expectedHeadSha: string
): boolean {
  return (
    GIT_OID_RE.test(expectedHeadSha) &&
    record.headSha?.toLowerCase() === expectedHeadSha.toLowerCase()
  );
}

export function buildExactHeadMergeArgs(input: {
  prNumber: number;
  repoSlug: string;
  expectedHeadSha: string;
}): string[] {
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    throw new Error("Merge requires a positive PR number");
  }
  if (!GIT_OID_RE.test(input.expectedHeadSha)) {
    throw new Error("Merge requires a full Git object ID");
  }
  return [
    "pr",
    "merge",
    String(input.prNumber),
    "--repo",
    input.repoSlug,
    "--squash",
    "--delete-branch",
    "--match-head-commit",
    input.expectedHeadSha.toLowerCase(),
  ];
}

export async function refreshWorkspacePr(
  workspace: Workspace
): Promise<PrRefreshResult> {
  const branch = workspaceBranch(workspace);
  if (!branch) {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch: "",
        state: "unknown",
        lastError: "Workspace has no Conductor workspace name yet.",
      }),
      repoSlug: null,
    };
  }

  const repoSlug = await resolveRepoSlug(workspace.repoPath);
  const branchExists = await remoteBranchExists(workspace.repoPath, branch);
  if (!repoSlug) {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch,
        state: "unknown",
        branchExists,
        lastError: "Could not resolve GitHub repo from origin remote.",
      }),
      repoSlug: null,
    };
  }

  const auth = await runGh(["auth", "status"]);
  if (auth.code !== 0) {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch,
        state: "unknown",
        branchExists,
        lastError: `gh auth unavailable: ${compactError(auth)}`,
      }),
      repoSlug,
    };
  }

  const prResult = await runGh([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "5",
    "--json",
    [
      "number",
      "title",
      "url",
      "state",
      "isDraft",
      "headRefName",
      "headRefOid",
      "baseRefName",
      "reviewDecision",
      "mergeStateStatus",
      "mergeable",
      "statusCheckRollup",
    ].join(","),
  ]);

  if (prResult.code !== 0) {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch,
        state: "unknown",
        branchExists,
        lastError: compactError(prResult),
      }),
      repoSlug,
    };
  }

  let prs: GithubPrJson[] = [];
  try {
    prs = JSON.parse(prResult.stdout) as GithubPrJson[];
  } catch {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch,
        state: "unknown",
        branchExists,
        lastError: "gh returned malformed PR JSON.",
      }),
      repoSlug,
    };
  }

  const pr = prs[0];
  if (!pr) {
    return {
      record: upsertPrRecord({
        workspaceId: workspace.id,
        repoPath: workspace.repoPath,
        branch,
        state: "none",
        branchExists,
        lastError: null,
      }),
      repoSlug,
    };
  }

  const checks = summarizeChecks(pr.statusCheckRollup ?? []);
  return {
    record: upsertPrRecord({
      workspaceId: workspace.id,
      repoPath: workspace.repoPath,
      branch,
      prNumber: pr.number ?? null,
      prUrl: pr.url ?? null,
      title: pr.title ?? null,
      state: normalizePrState(pr.state),
      isDraft: Boolean(pr.isDraft),
      headRef: pr.headRefName ?? branch,
      headSha: pr.headRefOid ?? null,
      baseRef: pr.baseRefName ?? null,
      reviewDecision: pr.reviewDecision ?? null,
      mergeStateStatus: pr.mergeStateStatus ?? null,
      mergeable: pr.mergeable ?? null,
      checksStatus: checks.status,
      checksSummary: checks.summary,
      branchExists,
      lastError: null,
    }),
    repoSlug,
  };
}

export async function mergeWorkspacePr(
  workspace: Workspace,
  record: PrRecord,
  expectedHeadSha: string = record.headSha ?? ""
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const repoSlug = await resolveRepoSlug(workspace.repoPath);
  if (!repoSlug) {
    return { ok: false, message: "Could not resolve GitHub repo from origin remote." };
  }
  if (!record.prNumber) {
    return { ok: false, message: "No PR number is recorded for this workspace." };
  }
  if (!canMergePr(record)) {
    return { ok: false, message: "PR is not currently eligible to merge." };
  }
  if (!matchesExpectedPrHead(record, expectedHeadSha)) {
    return { ok: false, message: "PR head changed; request a new merge confirmation." };
  }

  const result = await runGh(
    buildExactHeadMergeArgs({
      prNumber: record.prNumber,
      repoSlug,
      expectedHeadSha,
    }),
    { cwd: workspace.repoPath, timeoutMs: 120_000 }
  );
  if (result.code !== 0) {
    return { ok: false, message: compactError(result) };
  }
  return {
    ok: true,
    message: result.stdout.trim() || `Merged PR #${record.prNumber}.`,
  };
}

export async function checkGithubCli(): Promise<{
  ok: boolean;
  detail: string;
  fix?: string;
}> {
  const version = await runGh(["--version"]);
  if (version.code !== 0) {
    return {
      ok: false,
      detail: "gh CLI not available",
      fix: "Install GitHub CLI and run 'gh auth login'",
    };
  }
  const auth = await runGh(["auth", "status"]);
  if (auth.code !== 0) {
    return {
      ok: false,
      detail: `gh auth failed: ${compactError(auth)}`,
      fix: "Run 'gh auth login' with repo permissions",
    };
  }
  const firstLine = version.stdout.split("\n").find(Boolean) ?? "gh installed";
  return { ok: true, detail: firstLine };
}

async function resolveRepoSlug(repoPath: string): Promise<string | null> {
  const remote = await runGit(["remote", "get-url", "origin"], repoPath);
  if (remote.code !== 0) return null;
  return parseGitHubRepoSlug(remote.stdout.trim());
}

function parseGitHubRepoSlug(remoteUrl: string): string | null {
  const normalized = remoteUrl.trim().replace(/\.git$/, "");
  const httpsMatch = normalized.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)$/);
  if (httpsMatch) return httpsMatch[1];
  const sshMatch = normalized.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];
  const sshUrlMatch = normalized.match(/^ssh:\/\/git@github\.com\/([^/]+\/[^/]+)$/);
  if (sshUrlMatch) return sshUrlMatch[1];
  return null;
}

async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const result = await runGit(["ls-remote", "--exit-code", "--heads", "origin", branch], repoPath);
  return result.code === 0 && result.stdout.trim().length > 0;
}

export function normalizePrState(state: string | undefined): PrState {
  const value = state?.toUpperCase();
  if (value === "OPEN") return "open";
  if (value === "CLOSED") return "closed";
  if (value === "MERGED") return "merged";
  return "unknown";
}

export function summarizeChecks(rollup: unknown[]): {
  status: PrChecksStatus;
  summary: string;
} {
  if (!Array.isArray(rollup) || rollup.length === 0) {
    return { status: "unknown", summary: "no checks reported" };
  }

  let failing = 0;
  let pending = 0;
  let passing = 0;
  for (const raw of rollup) {
    const item = raw as any;
    const status = String(item?.status ?? "").toUpperCase();
    const conclusion = String(item?.conclusion ?? "").toUpperCase();
    const state = String(item?.state ?? "").toUpperCase();
    if (state) {
      if (state === "SUCCESS") {
        passing += 1;
      } else if (["ERROR", "FAILURE"].includes(state)) {
        failing += 1;
      } else {
        pending += 1;
      }
      continue;
    }
    if (status && status !== "COMPLETED") {
      pending += 1;
      continue;
    }
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) {
      passing += 1;
    } else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)) {
      failing += 1;
    } else {
      pending += 1;
    }
  }

  const parts = [
    passing > 0 ? `${passing} passing` : "",
    pending > 0 ? `${pending} pending` : "",
    failing > 0 ? `${failing} failing` : "",
  ].filter(Boolean);
  const summary = parts.join(", ") || "checks unavailable";
  if (failing > 0) return { status: "failing", summary };
  if (pending > 0) return { status: "pending", summary };
  return { status: "passing", summary };
}

function compactError(result: CommandResult): string {
  return (result.stderr || result.stdout || `exit ${result.code}`)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 300);
}

function runGit(args: string[], cwd: string): Promise<CommandResult> {
  return runCommand("git", args, { cwd });
}

function runGh(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; stdin?: string } = {}
): Promise<CommandResult> {
  return runCommand("gh", args, options);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; stdin?: string } = {}
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd ?? process.cwd(),
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 10,
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as any)?.code === "number"
            ? (error as any).code
            : error
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      }
    );
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}
