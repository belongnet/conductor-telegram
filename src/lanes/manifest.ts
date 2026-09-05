import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const PROVIDERS = ["claude", "codex", "cursor"] as const;
const MODELS = ["fable-5-1", "gpt-5.6-sol", "grok-4.6"] as const;
export const APPROVED_PROVIDER_MODELS = {
  claude: "fable-5-1",
  codex: "gpt-5.6-sol",
  cursor: "grok-4.6",
} as const;
export const APPROVED_PROVIDER_CAPACITY = {
  claude: 3,
  codex: 2,
  cursor: 2,
} as const;
const RUNTIME_KEYS = new Set([
  "workspace",
  "workspace_id",
  "workspaceid",
  "session",
  "session_id",
  "sessionid",
  "pr_url",
  "prurl",
  "pull_request_url",
  "reset_at",
  "reset_timestamp",
  "provider_reset_at",
]);

const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
const Provider = z.enum(PROVIDERS);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

function isSafePromptPath(value: string): boolean {
  if (
    path.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }
  const segments = value.split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== ".."
  );
}

const SAFE_VALIDATION_SCRIPT =
  /^(?:test(?::[A-Za-z0-9_.-]+)?|lint(?::[A-Za-z0-9_.-]+)?|typecheck(?::[A-Za-z0-9_.-]+)?|check(?::[A-Za-z0-9_.-]+)?|verify(?::[A-Za-z0-9_.-]+)?|build(?::[A-Za-z0-9_.-]+)?|qa|ci)$/i;
const UNSAFE_VALIDATION_TOKEN =
  /(?:^|[:/_-])(?:deploy|publish|release|push|destroy|apply|secret|outreach|spend)(?:$|[:/_-])/i;

function isSafeValidationCommand(argv: readonly string[]): boolean {
  if (
    argv.length === 0 ||
    argv.some(
      (argument) =>
        /[\r\n\0]/.test(argument) || UNSAFE_VALIDATION_TOKEN.test(argument)
    )
  ) {
    return false;
  }
  const executable = path.posix.basename(argv[0]).toLowerCase();
  const args = argv.slice(1);
  if (["pytest", "vitest", "jest", "tsc", "eslint", "ruff", "mypy"].includes(executable)) {
    return true;
  }
  if (["python", "python3"].includes(executable)) {
    return args[0] === "-m" && args[1] === "pytest";
  }
  if (["bash", "sh"].includes(executable)) {
    if (!args[0] || args[0] === "-c" || args[0].startsWith("-")) return false;
    const script = path.posix.basename(args[0]);
    return (
      /(?:test|check|lint|verify|qa)/i.test(script) ||
      args.includes("--check")
    );
  }
  if (["npm", "pnpm", "bun", "yarn"].includes(executable)) {
    const positional: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      if (["--prefix", "--filter", "--workspace", "--cwd", "--dir", "-C"].includes(args[index]!)) {
        index += 1;
        continue;
      }
      if (!args[index]!.startsWith("-")) positional.push(args[index]!);
    }
    if (positional[0] === "run") positional.shift();
    return Boolean(positional[0] && SAFE_VALIDATION_SCRIPT.test(positional[0]));
  }
  if (executable === "cargo") {
    return ["test", "check", "clippy", "build"].includes(args[0] ?? "");
  }
  if (executable === "go") {
    return ["test", "vet", "build"].includes(args[0] ?? "");
  }
  if (["make", "gmake"].includes(executable)) {
    const targets = args.filter((argument) => !argument.startsWith("-"));
    return targets.length > 0 && targets.every((target) => SAFE_VALIDATION_SCRIPT.test(target));
  }
  return false;
}

const ManifestSchema = z
  .object({
    version: z.literal(2),
    global: z
      .object({
        provider_capacity: z
          .object({
            claude: z.number().int().positive(),
            codex: z.number().int().positive(),
            cursor: z.number().int().positive(),
          })
          .strict(),
        provider_models: z
          .object({
            claude: z.enum(MODELS),
            codex: z.enum(MODELS),
            cursor: z.enum(MODELS),
          })
          .strict(),
      })
      .strict(),
    lanes: z
      .array(
        z
          .object({
            id: Id,
            title: z.string().min(1).max(240).optional(),
            repository: z
              .object({
                owner: Id,
                name: Id,
                base_branch: z.string().min(1).max(255),
              })
              .strict(),
            prompt: z
              .object({
                path: z
                  .string()
                  .min(1)
                  .max(1024)
                  .refine(
                    isSafePromptPath,
                    "must be a relative path contained by the manifest directory"
                  ),
                sha256: Sha256,
              })
              .strict(),
            priority: z.number().int(),
            preferred_providers: z.array(Provider).min(1),
            fallback_providers: z.array(Provider).default([]),
            dependencies: z
              .array(
                z
                  .object({
                    lane_id: Id,
                    milestone: z.enum(["pr_opened", "merged", "validated"]),
                  })
                  .strict()
              )
              .default([]),
            policy: z.discriminatedUnion("kind", [
              z.object({ kind: z.literal("one_shot") }).strict(),
              z
                .object({
                  kind: z.literal("recurring"),
                  schedule: z
                    .string()
                    .min(1)
                    .refine(
                      (value) =>
                        /^(?:daily|@daily|weekly|@weekly|every\s+[1-9]\d*\s*[mhd])$/i.test(
                          value.trim()
                        ),
                      "unsupported recurring schedule; use daily, weekly, or every <positive integer><m|h|d>"
                    ),
                })
                .strict(),
            ]),
            delivery_adapter: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("github"),
                  required_checks: z.array(z.string().min(1)).optional(),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("gitlab"),
                  required_checks: z.array(z.string().min(1)).optional(),
                })
                .strict(),
            ]),
            merge_policy: z
              .object({
                method: z.enum(["squash", "merge", "rebase"]),
                auto_merge: z.literal(true),
                deploy_notes: z.string().default(""),
                replay_notes: z.string().default(""),
              })
              .strict(),
            validation_profile: z
              .object({
                commands: z.array(z.array(z.string().min(1)).min(1)).default([]),
                probes: z
                  .array(
                    z
                      .object({
                        url: z
                          .string()
                          .url()
                          .refine(
                            (value) => {
                              try {
                                const protocol = new URL(value).protocol;
                                return protocol === "http:" || protocol === "https:";
                              } catch {
                                return false;
                              }
                            },
                            "must be a read-only HTTP(S) URL"
                          ),
                        method: z.literal("GET").default("GET"),
                      })
                      .strict()
                  )
                  .default([]),
              })
              .strict()
              .refine(
                (value) => value.commands.length > 0 || value.probes.length > 0,
                "validation profile requires a deterministic command or read-only probe"
              ),
            managed_tags: z.array(z.string().min(1).max(128)).min(1),
          })
          .strict()
      )
      .min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    for (const provider of PROVIDERS) {
      if (
        manifest.global.provider_capacity[provider] !==
        APPROVED_PROVIDER_CAPACITY[provider]
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["global", "provider_capacity", provider],
          message: `must be ${APPROVED_PROVIDER_CAPACITY[provider]}`,
        });
      }
      if (
        manifest.global.provider_models[provider] !==
        APPROVED_PROVIDER_MODELS[provider]
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["global", "provider_models", provider],
          message: `must be ${APPROVED_PROVIDER_MODELS[provider]}`,
        });
      }
    }
    const ids = new Set<string>();
    for (const [index, lane] of manifest.lanes.entries()) {
      if (ids.has(lane.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "id"],
          message: `duplicate lane id "${lane.id}"`,
        });
      }
      ids.add(lane.id);
      const providers = [...lane.preferred_providers, ...lane.fallback_providers];
      if (new Set(providers).size !== providers.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "fallback_providers"],
          message: "provider preference order contains a duplicate",
        });
      }
      if (
        providers.length !== PROVIDERS.length ||
        PROVIDERS.some((provider) => !providers.includes(provider))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "preferred_providers"],
          message:
            "provider rotation must include claude, codex, and cursor exactly once",
        });
      }
      const requiredChecks = lane.delivery_adapter.required_checks ?? [];
      if (new Set(requiredChecks).size !== requiredChecks.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery_adapter", "required_checks"],
          message: "required check names must be unique",
        });
      }
      for (const [commandIndex, command] of lane.validation_profile.commands.entries()) {
        if (!isSafeValidationCommand(command)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lanes", index, "validation_profile", "commands", commandIndex],
            message:
              "must be a bounded test/lint/typecheck/build/check command and must not deploy, publish, push, or change secrets",
          });
        }
      }
      for (const requiredTag of ["managed:growth", `lane:${lane.id}`]) {
        if (!lane.managed_tags.includes(requiredTag)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lanes", index, "managed_tags"],
            message: `must include recognized tag "${requiredTag}"`,
          });
        }
      }
      if (
        lane.delivery_adapter.kind === "gitlab" &&
        lane.merge_policy.method === "rebase"
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "merge_policy", "method"],
          message: "GitLab delivery supports squash or merge, not controller-initiated rebase",
        });
      }
    }
    for (const [index, lane] of manifest.lanes.entries()) {
      for (const [dependencyIndex, dependency] of lane.dependencies.entries()) {
        if (!ids.has(dependency.lane_id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lanes", index, "dependencies", dependencyIndex],
            message: `unknown dependency "${dependency.lane_id}"`,
          });
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const byId = new Map(manifest.lanes.map((lane) => [lane.id, lane]));
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (visited.has(id)) return true;
      visiting.add(id);
      for (const dependency of byId.get(id)?.dependencies ?? []) {
        if (!visit(dependency.lane_id)) return false;
      }
      visiting.delete(id);
      visited.add(id);
      return true;
    };
    for (const [index, lane] of manifest.lanes.entries()) {
      if (!visit(lane.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "dependencies"],
          message: "dependency graph contains a cycle",
        });
        break;
      }
    }
  });

export type LaneManifestV2 = z.infer<typeof ManifestSchema> & {
  manifestPath: string;
  manifestHash: string;
};
export type ManifestLane = LaneManifestV2["lanes"][number];
export type ManifestProvider = (typeof PROVIDERS)[number];

export const DEFAULT_LANE_MANIFEST_PATH = path.join(
  os.homedir(),
  ".conductor-telegram",
  "lanes.manifest.v2.json"
);

export class LaneManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneManifestError";
  }
}

function snakeCaseKey(value: string): string {
  return value.replace(/(?<!^)(?=[A-Z])/g, "_").toLowerCase();
}

function forbiddenRuntimePaths(value: unknown, at = "manifest"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      forbiddenRuntimePaths(entry, `${at}[${index}]`)
    );
  }
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => {
      const current = `${at}.${key}`;
      const own = RUNTIME_KEYS.has(snakeCaseKey(key)) ? [current] : [];
      return [...own, ...forbiddenRuntimePaths(child, current)];
    }
  );
}

export function canonicalManifestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalManifestJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, child]) =>
          `${JSON.stringify(key)}:${canonicalManifestJson(child)}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestHash(value: unknown): string {
  return createHash("sha256").update(canonicalManifestJson(value)).digest("hex");
}

export function resolveLanePromptPath(
  manifestPath: string,
  promptPath: string
): string {
  if (!isSafePromptPath(promptPath)) {
    throw new LaneManifestError(
      "Prompt path must be relative and contained by the manifest directory"
    );
  }
  const root = realpathSync(path.dirname(path.resolve(manifestPath)));
  const candidate = path.resolve(root, promptPath);
  if (!existsSync(candidate)) {
    throw new LaneManifestError(`Prompt does not exist: ${candidate}`);
  }
  const resolved = realpathSync(candidate);
  if (!resolved.startsWith(`${root}${path.sep}`) || !statSync(resolved).isFile()) {
    throw new LaneManifestError(
      `Prompt must resolve to a file beneath the manifest directory: ${promptPath}`
    );
  }
  return resolved;
}

export function laneManifestRevisionId(
  manifest: Pick<LaneManifestV2, "manifestHash">
): string {
  return `growth-v2-${manifest.manifestHash.slice(0, 20)}`;
}

export function parseLaneManifest(
  value: unknown,
  manifestPath: string,
  options: { verifyPrompts?: boolean } = {}
): LaneManifestV2 {
  const forbidden = forbiddenRuntimePaths(value);
  if (forbidden.length > 0) {
    throw new LaneManifestError(
      `Runtime IDs/URLs/reset timestamps are forbidden in Manifest v2: ${forbidden
        .slice(0, 5)
        .join(", ")}`
    );
  }
  const result = ManifestSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
      .join("; ");
    throw new LaneManifestError(`Invalid lane manifest: ${issues}`);
  }
  if (options.verifyPrompts !== false) {
    for (const lane of result.data.lanes) {
      const promptPath = resolveLanePromptPath(manifestPath, lane.prompt.path);
      const digest = createHash("sha256")
        .update(readFileSync(promptPath))
        .digest("hex");
      if (digest !== lane.prompt.sha256) {
        throw new LaneManifestError(
          `Lane ${lane.id} prompt hash mismatch: expected ${lane.prompt.sha256}, got ${digest}`
        );
      }
    }
  }
  return {
    ...result.data,
    manifestPath,
    manifestHash: manifestHash(result.data),
  };
}

export function laneManifestPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  return env.LANES_MANIFEST?.trim() || DEFAULT_LANE_MANIFEST_PATH;
}

export function loadLaneManifest(
  env: NodeJS.ProcessEnv = process.env
): LaneManifestV2 | null {
  const manifestPath = laneManifestPath(env);
  if (!existsSync(manifestPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new LaneManifestError(
      `Could not read lane manifest at ${manifestPath}: ${(error as Error).message}`
    );
  }
  return parseLaneManifest(parsed, manifestPath);
}
