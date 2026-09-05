import type { ManifestLane } from "./manifest.js";

function normalizedPath(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

/**
 * Canonicalize the HTTPS, SSH URL, and scp-style remotes Conductor projects
 * may expose. Lane repositories are GitHub/GitLab identities, whose paths are
 * compared case-insensitively here just as their delivery adapters do.
 */
export function repositoryRemoteIdentity(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;
  if (!value.includes("://")) {
    const scp = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (!scp) return null;
    const repositoryPath = normalizedPath(scp[2]);
    return repositoryPath ? `${scp[1].toLowerCase()}/${repositoryPath}` : null;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.hostname) return null;
    const repositoryPath = normalizedPath(decodeURIComponent(parsed.pathname));
    return repositoryPath
      ? `${parsed.hostname.toLowerCase()}/${repositoryPath}`
      : null;
  } catch {
    return null;
  }
}

export function laneRepositoryIdentity(lane: ManifestLane): string {
  const host = lane.delivery_adapter.kind === "gitlab" ? "gitlab.com" : "github.com";
  return `${host}/${lane.repository.owner}/${lane.repository.name}`.toLowerCase();
}
