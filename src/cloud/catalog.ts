import type { ConductorApiClient, ConductorApiProject } from "../integrations/conductor-api.js";
import { repositoryRemoteIdentity } from "../lanes/repository-identity.js";
import type { GatewayStore } from "./store.js";

export function githubSlug(remote: string): string {
  const identity = repositoryRemoteIdentity(remote);
  if (!identity?.startsWith("github.com/") || identity.split("/").length !== 3) throw new Error("Conductor Cloud requires a canonical GitHub repository");
  return identity.slice("github.com/".length);
}

export class ProjectCatalog {
  constructor(private readonly api: ConductorApiClient, private readonly store: GatewayStore) {}
  async projects(refresh = false): Promise<ConductorApiProject[]> {
    const cached = this.store.get<{ at: number; projects: ConductorApiProject[] }>("projects");
    if (!refresh && cached && Date.now() - cached.at < 60_000) return cached.projects;
    const projects = (await this.api.listProjects()).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    this.store.set("projects", { at: Date.now(), projects });
    return projects;
  }
  async resolve(input: string): Promise<ConductorApiProject> {
    const projects = await this.projects();
    const identity = repositoryRemoteIdentity(input);
    const exact = projects.filter(p => p.id === input || p.name.toLowerCase() === input.toLowerCase() || (identity && repositoryRemoteIdentity(p.gitRemote) === identity));
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error("Ambiguous repository. Use the Conductor project ID.");
    if (/^[1-9]\d*$/.test(input) && projects[Number(input) - 1]) return projects[Number(input) - 1];
    const prefix = projects.filter(p => p.name.toLowerCase().startsWith(input.toLowerCase()));
    if (prefix.length === 1) return prefix[0];
    throw new Error("Repository unavailable or ambiguous. Use /projects and its project ID.");
  }
}

/**
 * GitHub answers 404 both for a missing pull request and for a private repository the token was never
 * granted, so a status alone never says which. Callers classify a refusal by probing the repository.
 */
export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly rateLimited = false) { super(message); this.name = "GitHubError"; }
}

export interface CloudPr { url: string; number: number; head: string; base: string; branch: string; state: string; merged: boolean; draft: boolean }
export class CloudGitHub {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async request(slug: string, suffix: string): Promise<any> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new GitHubError("Invalid repository identity", 0);
    if (!this.token) throw new GitHubError("GitHub credentials are required for PR status and reviews", 0);
    const response = await this.fetcher(`https://api.github.com/repos/${slug}${suffix}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "User-Agent": "conductor-telegram" },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new GitHubError(`GitHub request failed (${response.status})`, response.status, response.status === 429 ||
      (response.status === 403 && (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))));
    return response.json();
  }
  /** One call proves both that the token was granted this repository and that it may read pull requests. */
  async access(slug: string): Promise<{ readable: boolean; status: number }> {
    try { await this.request(slug, "/pulls?state=open&per_page=1"); return { readable: true, status: 200 }; }
    catch (error) {
      // A rate limit says nothing about access, and an outage must never be remembered as "cannot read".
      if (error instanceof GitHubError && !error.rateLimited && [0, 401, 403, 404].includes(error.status)) return { readable: false, status: error.status };
      throw error;
    }
  }
  /** What the owner has to change, in one sentence. */
  advice(slug: string, status: number): string {
    if (status === 401) return "GitHub rejected the gateway's token. It is expired or revoked, so replace GH_TOKEN.";
    if (status === 403) return `The gateway's GitHub token can see ${slug} but not its pull requests. Grant it Pull requests: read, or authorize it for the organization.`;
    if (status === 404) return `The gateway's GitHub token cannot read ${slug}. Add that repository to the token with Pull requests: read.`;
    return this.token ? `Pull request features need a GitHub repository, and this workspace uses ${slug || "another host"}.` : "This gateway has no GitHub token, so set GH_TOKEN.";
  }
  async pr(slug: string, url: string): Promise<CloudPr> {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/);
    if (parsed.hostname !== "github.com" || !match || match[1].toLowerCase() !== slug.toLowerCase()) throw new Error("PR belongs to another repository");
    const pr = await this.request(slug, `/pulls/${match[2]}`);
    if (!/^[a-f0-9]{40}$/i.test(pr.head?.sha ?? "") || !/^[a-f0-9]{40}$/i.test(pr.base?.sha ?? "")) throw new Error("GitHub returned invalid PR commit identities");
    return { url: pr.html_url, number: pr.number, head: pr.head.sha, base: pr.base.sha, branch: pr.head.ref, state: pr.state, merged: !!pr.merged, draft: !!pr.draft };
  }
  async find(slug: string, branch: string): Promise<CloudPr | null> {
    const prs = await this.request(slug, `/pulls?state=open&head=${encodeURIComponent(`${slug.split("/")[0]}:${branch}`)}`);
    if (prs.length !== 1) return null;
    return this.pr(slug, prs[0].html_url);
  }
}
