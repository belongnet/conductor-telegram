import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export const DOPPLER_RUNTIME_SECRET_NAMES = Object.freeze([
  "BOT_TOKEN",
  "OWNER_CHAT_ID",
  "OWNER_USER_ID",
  "CONDUCTOR_API_BASE_URL",
  "CONDUCTOR_API_KEY",
  "CONDUCTOR_CLOUD_BACKEND",
]);

export interface DopplerRuntime {
  executable: string;
  project: string;
  config: string;
  secretNames?: string[];
}

export class DopplerRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DopplerRuntimeError";
  }
}

function withoutManagedSecretValues(
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const name of DOPPLER_RUNTIME_SECRET_NAMES) {
    delete sanitized[name];
  }
  return sanitized;
}

export function buildServiceDopplerEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const sanitized = withoutManagedSecretValues(env);
  delete sanitized.DOPPLER_TOKEN;
  delete sanitized.DOPPLER_PROJECT;
  delete sanitized.DOPPLER_CONFIG;
  return sanitized;
}

export function stripDopplerManagedConfig(
  config: Config,
  secretNames: ReadonlySet<string>
): Config {
  return {
    ...config,
    botToken: secretNames.has("BOT_TOKEN") ? "" : config.botToken,
    ownerChatId: secretNames.has("OWNER_CHAT_ID") ? "" : config.ownerChatId,
    ownerUserId: secretNames.has("OWNER_USER_ID")
      ? undefined
      : config.ownerUserId,
    conductorApiBaseUrl: secretNames.has("CONDUCTOR_API_BASE_URL")
      ? undefined
      : config.conductorApiBaseUrl,
    conductorApiKey: secretNames.has("CONDUCTOR_API_KEY")
      ? undefined
      : config.conductorApiKey,
    conductorCloudBackend: secretNames.has("CONDUCTOR_CLOUD_BACKEND")
      ? undefined
      : config.conductorCloudBackend,
  };
}

export function configuredDopplerReference(
  config: Pick<Config, "dopplerProject" | "dopplerConfig">
): { project: string; config: string } | null {
  const project = config.dopplerProject?.trim() ?? "";
  const dopplerConfig = config.dopplerConfig?.trim() ?? "";
  if (!project && !dopplerConfig) return null;
  if (!project || !dopplerConfig) {
    throw new DopplerRuntimeError(
      "Both Doppler project and config must be configured"
    );
  }
  return { project, config: dopplerConfig };
}

export function findDopplerExecutable(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const candidates = [
    "/opt/homebrew/bin/doppler",
    "/usr/local/bin/doppler",
    ...(env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "doppler")),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (!path.isAbsolute(candidate) || !existsSync(candidate)) continue;
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Try the next executable candidate.
    }
  }
  return null;
}

export function resolveDopplerRuntime(
  config: Pick<Config, "dopplerProject" | "dopplerConfig">,
  env: NodeJS.ProcessEnv = process.env
): DopplerRuntime | null {
  const reference = configuredDopplerReference(config);
  if (!reference) return null;
  const executable = findDopplerExecutable(env);
  if (!executable) {
    throw new DopplerRuntimeError(
      "Doppler runtime is configured but the doppler CLI is not executable"
    );
  }
  return { executable, ...reference };
}

export function isDopplerRuntimeActive(
  runtime: Pick<DopplerRuntime, "project" | "config">,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return (
    env.DOPPLER_PROJECT === runtime.project &&
    env.DOPPLER_CONFIG === runtime.config
  );
}

export function buildDopplerRunArgs(
  runtime: Pick<DopplerRuntime, "project" | "config" | "secretNames">,
  command: string[]
): string[] {
  if (command.length === 0) {
    throw new DopplerRuntimeError("Doppler runtime command cannot be empty");
  }
  const secretNames =
    runtime.secretNames ?? [...DOPPLER_RUNTIME_SECRET_NAMES];
  if (
    secretNames.length === 0 ||
    secretNames.some(
      (name) => !DOPPLER_RUNTIME_SECRET_NAMES.includes(name)
    )
  ) {
    throw new DopplerRuntimeError(
      "Doppler runtime secret allowlist is empty or invalid"
    );
  }
  return [
    "run",
    "--project",
    runtime.project,
    "--config",
    runtime.config,
    "--no-exit-on-missing-only-secrets",
    "--only-secrets",
    secretNames.join(","),
    "--",
    ...command,
  ];
}

export function readDopplerSecretNames(
  runtime: DopplerRuntime,
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const result = spawnSync(
    runtime.executable,
    [
      "secrets",
      "--only-names",
      "--json",
      "--project",
      runtime.project,
      "--config",
      runtime.config,
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      env,
    }
  );
  if (result.status !== 0) {
    throw new DopplerRuntimeError(
      "Cannot access the configured Doppler project/config"
    );
  }
  try {
    const payload = JSON.parse(result.stdout) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("unexpected response");
    }
    return new Set(Object.keys(payload));
  } catch {
    throw new DopplerRuntimeError(
      "Doppler returned an invalid secret-name response"
    );
  }
}

export function readAvailableDopplerRuntimeSecretNames(
  runtime: DopplerRuntime,
  env: NodeJS.ProcessEnv = process.env
): Set<string> {
  const configuredNames = readDopplerSecretNames(runtime, env);
  const scopedNames = DOPPLER_RUNTIME_SECRET_NAMES.filter((name) =>
    configuredNames.has(name)
  );
  if (scopedNames.length === 0) return new Set();

  const probe = spawnSync(
    runtime.executable,
    buildDopplerRunArgs(
      { ...runtime, secretNames: scopedNames },
      [
        process.execPath,
        "-e",
        "const names=process.argv[1].split(',');process.stdout.write(JSON.stringify(names.filter((name)=>process.env[name]?.trim())));",
        scopedNames.join(","),
      ]
    ),
    {
      encoding: "utf8",
      timeout: 15_000,
      env: withoutManagedSecretValues(env),
    }
  );
  if (probe.status !== 0) {
    throw new DopplerRuntimeError(
      "Cannot validate values in the configured Doppler project/config"
    );
  }
  try {
    const payload = JSON.parse(probe.stdout) as unknown;
    if (
      !Array.isArray(payload) ||
      payload.some(
        (name) => typeof name !== "string" || !scopedNames.includes(name)
      )
    ) {
      throw new Error("unexpected response");
    }
    return new Set(payload);
  } catch {
    throw new DopplerRuntimeError(
      "Doppler returned an invalid runtime-value probe response"
    );
  }
}

export function runWithDoppler(
  runtime: DopplerRuntime,
  command: string[]
): number {
  const availableNames = readAvailableDopplerRuntimeSecretNames(runtime);
  const scopedRuntime: DopplerRuntime = {
    ...runtime,
    secretNames: DOPPLER_RUNTIME_SECRET_NAMES.filter((name) =>
      availableNames.has(name)
    ),
  };
  const result = spawnSync(
    runtime.executable,
    buildDopplerRunArgs(scopedRuntime, command),
    {
      stdio: "inherit",
      env: process.env,
    }
  );
  if (result.error) {
    throw new DopplerRuntimeError(
      `Could not start Doppler runtime: ${result.error.message}`
    );
  }
  return result.status ?? 1;
}
