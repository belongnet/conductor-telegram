import { execFile } from "node:child_process";
import type { PrChecksStatus, PrRecord, PrState, Workspace } from "../types/index.js";
import { upsertPrRecord } from "../store/queries.js";

const COMMAND_TIMEOUT_MS = 30_000;

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
  baseRefName?: string;
  reviewDecision?: string | null;
  mergeStateStatus?: string | null;
  mergeable?: string | null;
  statusCheckRollup?: unknown[];
}

export interface PrRefreshResult {
  record: PrRecord;
  repoSlug: string | null;
}

export function workspaceBranch(workspace: Workspace): string | null {
  if (!workspace.conductorWorkspaceName) return null;
  return `belongcond/${workspace.conductorWorkspaceName}`;
}

export function canMergePr(record: PrRecord): boolean {
  if (record.state !== "open") return false;
  if (record.isDraft) return false;
  if (record.checksStatus !== "passing") return false;
  const mergeState = record.mergeStateStatus?.toUpperCase() ?? "";
  return mergeState === "CLEAN" || mergeState === "HAS_HOOKS";
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
  record: PrRecord
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

  const result = await runGh(
    [
      "pr",
      "merge",
      String(record.prNumber),
      "--repo",
      repoSlug,
      "--squash",
      "--delete-branch",
    ],
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
