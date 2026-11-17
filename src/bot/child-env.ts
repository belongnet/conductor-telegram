import os from "node:os";

/**
 * What a process the bot starts may inherit from it. The bot holds Telegram,
 * Conductor, Command Center and approval credentials; none of them is here.
 */
export const CHILD_ENV_ALLOWLIST = Object.freeze([
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
] as const);

/**
 * The environment for a helper the bot runs itself, such as the router's
 * Claude CLI or voice transcription: the agent allowlist plus the operator's
 * HOME (and CLAUDE_CONFIG_DIR when set), where the Claude CLI keeps its login.
 */
export function buildHelperEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  result.HOME = source.HOME?.trim() || os.homedir();
  const claudeConfig = source.CLAUDE_CONFIG_DIR?.trim();
  if (claudeConfig) result.CLAUDE_CONFIG_DIR = claudeConfig;
  return result;
}
