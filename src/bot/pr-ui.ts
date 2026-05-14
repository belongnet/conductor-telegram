import path from "node:path";
import type { PrRecord, Workspace } from "../types/index.js";
import { btn, escHtml, styledKeyboard } from "./format.js";
import { canMergePr } from "./github.js";

export function compactPrBadge(record: PrRecord | undefined): string {
  if (!record) return "PR: unknown";
  if (record.lastError) return "PR: check failed";
  if (record.state === "none") {
    return record.branchExists ? "PR: none, branch pushed" : "PR: none";
  }
  const draft = record.isDraft ? " draft" : "";
  const checks =
    record.checksStatus === "unknown" ? "" : `, ${record.checksStatus}`;
  return `PR: ${record.state}${draft}${checks}`;
}

export function formatPrCard(workspace: Workspace, record: PrRecord): string {
  const name = workspace.conductorWorkspaceName ?? workspace.name;
  const repo = path.basename(workspace.repoPath);
  const lines = [
    `<b>Ship status</b>`,
    `<b>${escHtml(name)}</b> · <code>${escHtml(repo)}</code>`,
    `Branch: <code>${escHtml(record.branch || "(unknown)")}</code>`,
    `State: <b>${escHtml(describeState(record))}</b>`,
  ];

  if (record.prUrl) {
    lines.push(`PR: <a href="${escHtml(record.prUrl).replace(/"/g, "&quot;")}">${escHtml(`#${record.prNumber ?? "?"} ${record.title ?? "Pull request"}`)}</a>`);
  } else {
    lines.push("PR: <i>not found</i>");
  }

  lines.push(`Checks: <code>${escHtml(record.checksStatus)}</code>${record.checksSummary ? ` (${escHtml(record.checksSummary)})` : ""}`);

  if (record.reviewDecision) {
    lines.push(`Review: <code>${escHtml(record.reviewDecision)}</code>`);
  }
  if (record.mergeStateStatus) {
    lines.push(`Merge state: <code>${escHtml(record.mergeStateStatus)}</code>`);
  }
  if (record.branchExists && (record.state === "none" || record.state === "closed" || record.state === "merged")) {
    lines.push(`<i>Stale branch signal: branch still exists on origin.</i>`);
  }
  if (record.lastError) {
    lines.push(`<i>${escHtml(record.lastError)}</i>`);
  }

  lines.push(`Last checked: <code>${escHtml(record.lastCheckedAt ?? "never")}</code>`);
  return lines.join("\n");
}

export function prKeyboard(record: PrRecord, workspace: Workspace): Record<string, any> {
  const rows = [
    [
      btn("Refresh", `pr:refresh:${workspace.id}`),
      btn("Ask Agent To Fix", `pr:fix:${workspace.id}`),
    ],
  ];

  if (canMergePr(record)) {
    rows.push([btn("Merge PR", `pr:merge:${workspace.id}`)]);
  }

  if (workspace.status === "done" || workspace.status === "failed" || workspace.status === "stopped") {
    rows.push([btn("Archive", `archive:${workspace.id}`)]);
  }

  return styledKeyboard(rows);
}

function describeState(record: PrRecord): string {
  if (record.lastError) return "verification failed";
  if (record.state === "none") {
    return record.branchExists ? "no PR; branch exists" : "no PR";
  }
  if (record.state === "open" && record.isDraft) return "draft";
  if (record.state === "open" && canMergePr(record)) return "ready to merge";
  if (record.state === "open") return "open";
  if (record.state === "closed") return "closed unmerged";
  if (record.state === "merged") return "merged";
  return "unknown";
}
