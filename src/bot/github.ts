import { execFile } from "node:child_process";
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
  statusCheckRollup?: unknown[];
  mergeCommit?: { oid?: string } | null;
  reviews?: Array<{
    body?: string;
    state?: string;
    submittedAt?: string;
    commit?: { oid?: string } | null;
  }>;
}

export interface GithubPrReviewSnapshot {
  body: string;
  state: string;
  submittedAt: string;
  commitSha: string | null;
}

export interface GithubPrPolicySnapshot {
  url: string;
  prNumber: number | null;
  state: PrState;
  isDraft: boolean;
  headSha: string | null;
  reviewDecision: string | null;
  mergeStateStatus: string | null;
  mergeable: string | null;
  checksStatus: PrChecksStatus;
  checksSummary: string;
  mergeCommitSha: string | null;
  reviews: GithubPrReviewSnapshot[];
}

export interface PrRefreshResult {
  record: PrRecord;
  repoSlug: string | null;
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
): boolean {
  if (record.state !== "open") return false;
  if (record.isDraft) return false;
  if (!record.prNumber || !Number.isInteger(record.prNumber)) return false;
  if (!record.headSha || !GIT_OID_RE.test(record.headSha)) return false;
  if (record.reviewDecision?.toUpperCase() !== "APPROVED") return false;
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
  return {
    url: pr.url ?? prUrl,
    prNumber: pr.number ?? null,
    state: normalizePrState(pr.state),
    isDraft: Boolean(pr.isDraft),
    headSha: pr.headRefOid ?? null,
    reviewDecision: pr.reviewDecision ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    mergeable: pr.mergeable ?? null,
    checksStatus: checks.status,
    checksSummary: checks.summary,
    mergeCommitSha: pr.mergeCommit?.oid?.toLowerCase() ?? null,
    reviews: (pr.reviews ?? []).map((review) => ({
      body: review.body ?? "",
      state: review.state ?? "",
      submittedAt: review.submittedAt ?? "",
      commitSha: review.commit?.oid?.toLowerCase() ?? null,
    })),
  };
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
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return runCommand("gh", args, options);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {}
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
  });
}
