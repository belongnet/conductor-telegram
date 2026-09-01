import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ConductorApiAgent } from "../integrations/conductor-api.js";

const LaneIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "lane id must be letters, digits, underscore, or hyphen"
  );

const ProviderNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]*$/,
    "provider name must be letters, digits, underscore, or hyphen"
  );

const AgentSchema = z.enum(["claude", "codex", "cursor"]);

const ProviderSchema = z.object({
  agent: AgentSchema,
  model: z.string().min(1),
  effort: z.string().min(1).default("high"),
  gapHours: z.number().finite().nonnegative(),
  maxActive: z.number().int().positive().default(1),
});

const LaneSchema = z.object({
  id: LaneIdSchema,
  title: z.string().min(1),
  provider: z.union([ProviderNameSchema, z.literal("any")]),
  repoUrl: z.string().url(),
  projectId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  after: z.array(LaneIdSchema).default([]),
  sessionId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
});

const LanesConfigSchema = z
  .object({
    intervalMinutes: z.number().finite().positive(),
    providers: z.record(ProviderNameSchema, ProviderSchema),
    lanes: z.array(LaneSchema).min(1),
  })
  .superRefine((config, context) => {
    const ids = new Set<string>();
    for (const [index, lane] of config.lanes.entries()) {
      if (ids.has(lane.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "id"],
          message: `duplicate lane id "${lane.id}"`,
        });
      }
      ids.add(lane.id);
      if (lane.provider !== "any" && !(lane.provider in config.providers)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "provider"],
          message: `unknown provider "${lane.provider}"`,
        });
      }
      for (const [depIndex, dep] of lane.after.entries()) {
        if (!ids.has(dep) && !config.lanes.some((other) => other.id === dep)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["lanes", index, "after", depIndex],
            message: `unknown dependency "${dep}"`,
          });
        }
      }
    }
  });

export type LanesProviderConfig = {
  agent: ConductorApiAgent;
  model: string;
  effort: string;
  gapHours: number;
  maxActive: number;
};

export type LaneConfig = {
  id: string;
  title: string;
  provider: string;
  repoUrl: string;
  projectId?: string;
  prompt: string;
  after: string[];
  sessionId?: string;
  workspaceId?: string;
};

export type LanesConfig = {
  intervalMinutes: number;
  providers: Record<string, LanesProviderConfig>;
  lanes: LaneConfig[];
  configPath: string;
};

export const DEFAULT_LANES_CONFIG_PATH = path.join(
  os.homedir(),
  ".conductor-telegram",
  "lanes.json"
);

export function lanesConfigPath(
  env: NodeJS.ProcessEnv = process.env
): string {
  const fromEnv = env.LANES_CONFIG?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_LANES_CONFIG_PATH;
}

export class LanesConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LanesConfigError";
  }
}

/**
 * Load the lanes config. Missing file → feature is inert (`null`).
 * A present but invalid file throws so the scheduler can log and skip.
 */
export function loadLanesConfig(
  env: NodeJS.ProcessEnv = process.env
): LanesConfig | null {
  const configPath = lanesConfigPath(env);
  if (!existsSync(configPath)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new LanesConfigError(
      `Could not read lanes config at ${configPath}: ${(error as Error).message}`
    );
  }

  const result = LanesConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new LanesConfigError(`Invalid lanes config at ${configPath}: ${issues}`);
  }

  return { ...result.data, configPath };
}

export function providerNames(config: LanesConfig): string[] {
  return Object.keys(config.providers);
}
