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

export interface CloudPr { url: string; number: number; head: string; base: string; branch: string; state: string; merged: boolean; draft: boolean }
export class CloudGitHub {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}
  async request(slug: string, suffix: string): Promise<any> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error("Invalid repository identity");
    if (!this.token) throw new Error("GitHub credentials are required for PR status and reviews");
    const response = await this.fetcher(`https://api.github.com/repos/${slug}${suffix}`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github+json", "User-Agent": "conductor-telegram" },
      signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
    return response.json();
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
