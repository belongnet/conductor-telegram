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
  maxNudges: z.number().int().positive().default(8),
});

const StageBaseSchema = z.object({
  rotation: z.array(ProviderNameSchema).min(1),
  prompt: z.string().min(1),
});

const DeliverySchema = z.object({
  review: StageBaseSchema.optional(),
  finals: StageBaseSchema.extend({
    rotation: z.array(ProviderNameSchema).min(2),
  }).optional(),
  merge: StageBaseSchema.extend({
    method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    deployNotes: z.string().default(""),
    replayNotes: z.string().default(""),
  }).optional(),
  validation: StageBaseSchema.extend({
    verification: z.string().trim().min(1),
  }).optional(),
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
  delivery: DeliverySchema.optional(),
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
      const stages: Array<[string, { rotation: string[] }]> = lane.delivery
        ? Object.entries(lane.delivery).flatMap(([name, stage]) =>
            stage ? [[name, stage]] : []
          )
        : [];
      if (lane.delivery?.merge && !lane.delivery.finals) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery", "merge"],
          message: "merge requires finals so two current approvals can be proven",
        });
      }
      if (lane.delivery?.validation && !lane.delivery.merge) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery", "validation"],
          message: "validation requires merge so a merged base can be proven",
        });
      }
      if (
        lane.provider !== "any" &&
        lane.delivery?.review &&
        !lane.delivery.review.rotation.some(
          (provider) => provider !== lane.provider
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery", "review", "rotation"],
          message: "review rotation needs a provider other than the author",
        });
      }
      if (
        lane.provider !== "any" &&
        lane.delivery?.finals &&
        new Set(
          lane.delivery.finals.rotation.filter(
            (provider) => provider !== lane.provider
          )
        ).size < 2
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery", "finals", "rotation"],
          message: "finals rotation needs two providers other than the author",
        });
      }
      if (
        lane.provider !== "any" &&
        lane.delivery?.merge &&
        !lane.delivery.merge.rotation.some(
          (provider) => provider !== lane.provider,
        )
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index, "delivery", "merge", "rotation"],
          message: "merge rotation needs a provider other than the author",
        });
      }
      for (const [stageName, stage] of stages) {
        const seenProviders = new Set<string>();
        for (const [providerIndex, provider] of stage.rotation.entries()) {
          if (!(provider in config.providers)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["lanes", index, "delivery", stageName, "rotation", providerIndex],
              message: `unknown provider "${provider}"`,
            });
          }
          if (seenProviders.has(provider)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["lanes", index, "delivery", stageName, "rotation", providerIndex],
              message: `duplicate provider "${provider}"`,
            });
          }
          seenProviders.add(provider);
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
  maxNudges: number;
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
  delivery?: LaneDeliveryConfig;
};

export type LaneStageConfig = {
  rotation: string[];
  prompt: string;
};

export type LaneMergeConfig = LaneStageConfig & {
  method: "squash" | "merge" | "rebase";
  deployNotes: string;
  replayNotes: string;
};

export type LaneValidationConfig = LaneStageConfig & {
  verification: string;
};

export type LaneDeliveryConfig = {
  review?: LaneStageConfig;
  finals?: LaneStageConfig;
  merge?: LaneMergeConfig;
  validation?: LaneValidationConfig;
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
