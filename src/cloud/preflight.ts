import {existsSync} from "node:fs";
import {createConductorApiClientFromEnv} from "../integrations/conductor-api.js";
import type {Config} from "../cli/config.js";
import {CloudGitHub, githubSlug} from "./catalog.js";
export interface CloudCheck {name: string; ok: boolean; detail: string; fix?: string}

/**
 * An authenticated token proves nothing about a repository: a fine-grained token reads only the
 * repositories it was granted, and GitHub answers 404 for the rest.
 */
export async function githubRepositoryAccess(projects: Array<{gitRemote: string}>, token: string, fetcher: typeof fetch = fetch): Promise<CloudCheck> {
  const slugs = [...new Set(projects.flatMap(p => { try { return [githubSlug(p.gitRemote)]; } catch { return []; } }))].sort();
  const github = new CloudGitHub(token, fetcher);
  const unreadable: string[] = []; let unchecked = 0;
  for (const slug of slugs) {
    try { if (!(await github.access(slug)).readable) unreadable.push(slug); } catch { unchecked++; }
  }
  return {name: "GitHub repositories", ok: unreadable.length === 0,
    detail: unreadable.length ? `Token cannot read: ${unreadable.join(", ")}`
      : `${slugs.length - unchecked} of ${slugs.length} project repositories readable${unchecked ? `; ${unchecked} not checked because GitHub did not answer` : ""}`,
    ...(unreadable.length ? {fix: "Add these repositories to the gateway's GitHub token with Pull requests: read. /review and /prs cannot work without it."} : {})};
}

/** Read-only prerequisites. Provider execution and owner-chat acceptance are separate live gates. */
export async function cloudPreflight(config: Config, fetcher: typeof fetch = fetch): Promise<CloudCheck[]> {
  const checks: CloudCheck[] = [];
  let remotes: Array<{gitRemote: string}> = [];
  const env = {...process.env, CONDUCTOR_CLOUD_BACKEND: "api", CONDUCTOR_API_MAX_RETRIES: "0", CONDUCTOR_API_TIMEOUT_MS: "10000",
    ...(config.conductorApiKey ? {CONDUCTOR_API_KEY: config.conductorApiKey} : {}),
    ...(config.conductorApiBaseUrl ? {CONDUCTOR_API_BASE_URL: config.conductorApiBaseUrl} : {})};
  try {
    const api = createConductorApiClientFromEnv(env);
    if (!api) throw new Error("Organization API key required");
    const [identity, projects] = await Promise.all([api.getIdentity(), api.listProjects()]);
    remotes = projects;
    checks.push({name: "Native Conductor", ok: projects.length > 0 && !identity.workspaceId, detail: `${projects.length} accessible projects; auth=${identity.authMethod}`});
  } catch { checks.push({name: "Native Conductor", ok: false, detail: "Organization API credentials or project access unavailable"}); }
  try {
    const response = await fetcher(`https://api.telegram.org/bot${config.botToken}/getMe`, {signal: AbortSignal.timeout(10000)});
    const bot = await response.json() as any;
    checks.push({name: "Telegram identity", ok: response.ok && bot.ok === true, detail: bot.ok ? `@${bot.result.username} (${bot.result.id})` : "Bot credentials rejected"});
  } catch { checks.push({name: "Telegram identity", ok: false, detail: "Telegram unreachable"}); }
  checks.push({name: "Owner chat", ok: !!config.ownerChatId && config.ownerChatId !== "0" && (!config.ownerChatId.startsWith("-") || !!config.ownerUserId), detail: "An owner chat and group owner user must be configured"});
  try {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    if (!token) throw new Error("missing");
    const response = await fetcher("https://api.github.com/user", {headers: {Authorization: `Bearer ${token}`, "User-Agent": "conductor-telegram"}, signal: AbortSignal.timeout(10000)});
    checks.push({name: "GitHub API", ok: response.ok, detail: response.ok ? "Authenticated" : "Credentials rejected"});
    if (response.ok && remotes.length) checks.push(await githubRepositoryAccess(remotes, token, fetcher));
  } catch { checks.push({name: "GitHub API", ok: false, detail: "Credentials or connectivity unavailable"}); }
  try {
    const url = new URL(config.bridgePublicUrl ?? "");
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    const response = await fetcher(`${url.origin}/health/live`, {redirect: "error", signal: AbortSignal.timeout(10000)});
    checks.push({name: "Bridge HTTPS", ok: response.ok && (await response.json() as any).live === true, detail: `${url.origin}: HTTPS liveness probe`});
  } catch { checks.push({name: "Bridge HTTPS", ok: false, detail: "Approved HTTPS bridge origin is missing or unreachable"}); }
  checks.push({name: "Linux voice", ok: [process.env.FFMPEG_BIN ?? "/usr/bin/ffmpeg", process.env.TELEGRAM_WHISPER_BIN ?? "", process.env.TELEGRAM_WHISPER_MODEL ?? ""].every(p => !!p && existsSync(p)), detail: "FFmpeg, Whisper executable, and model must be present in the release"});
  checks.push({name: "Native review policy", ok: config.cloudReviewPolicy === "native", detail: config.cloudReviewPolicy === "native" ? "Dedicated findings session with normal Conductor permissions" : "Native reviews disabled"});
  return checks;
}
