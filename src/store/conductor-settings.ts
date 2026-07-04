/**
 * Conductor 0.72+ settings access.
 *
 * Conductor migrated its settings from the `settings` table in conductor.db to
 * a file-backed ~/.conductor/settings.toml (the old DB rows still exist but
 * carry a `deprecated_at` stamp and stop receiving updates). We read the TOML
 * first and fall back to the DB row so the bot keeps working against both old
 * and new Conductor versions.
 *
 * The parser below intentionally covers only the subset Conductor writes:
 * `[section]` / `[section.sub]` headers, bare or quoted keys, and string /
 * boolean / number values. Anything else is ignored rather than fatal.
 */

import { readFileSync, statSync } from "node:fs";
import Database from "better-sqlite3";

const CONDUCTOR_SETTINGS_PATH_DEFAULT = `${process.env.HOME}/.conductor/settings.toml`;

const CONDUCTOR_DB_PATH_DEFAULT = `${process.env.HOME}/Library/Application Support/com.conductor.app/conductor.db`;

/** Legacy settings-table key → dotted path in settings.toml. */
const LEGACY_KEY_TO_TOML_PATH: Record<string, string> = {
  default_model: "models.default",
  review_model: "models.review",
  default_codex_thinking_level: "models.codex.default_thinking_level",
  review_codex_thinking_level: "models.codex.review_thinking_level",
  default_claude_effort_level: "models.claude_code.default_effort_level",
  review_claude_effort_level: "models.claude_code.review_effort_level",
  branch_prefix_type: "git.branch_prefix_type",
  branch_prefix: "git.branch_prefix",
};

export type TomlValue = string | number | boolean;

/**
 * Parse the small TOML subset Conductor's settings schema uses into a flat
 * map of "section.sub.key" → value. Unparseable lines are skipped.
 */
export function parseSimpleToml(text: string): Map<string, TomlValue> {
  const values = new Map<string, TomlValue>();
  let section = "";

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([A-Za-z0-9_."'-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].replace(/["']/g, "");
      continue;
    }

    const kvMatch = line.match(/^("(?:[^"]*)"|'(?:[^']*)'|[A-Za-z0-9_$-]+)\s*=\s*(.+)$/);
    if (!kvMatch) continue;

    const key = kvMatch[1].replace(/^["']|["']$/g, "");
    const value = parseTomlValue(kvMatch[2].trim());
    if (value === undefined) continue;

    values.set(section ? `${section}.${key}` : key, value);
  }

  return values;
}

function parseTomlValue(raw: string): TomlValue | undefined {
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end > 0 ? raw.slice(1, end) : undefined;
  }
  if (raw.startsWith("'")) {
    const end = raw.indexOf("'", 1);
    return end > 0 ? raw.slice(1, end) : undefined;
  }
  // Strip trailing inline comment from unquoted values.
  const bare = raw.split("#")[0].trim();
  if (bare === "true") return true;
  if (bare === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
  // Arrays/tables/dates are not needed for the keys we read; skip them.
  return undefined;
}

interface TomlCache {
  path: string;
  mtimeMs: number;
  values: Map<string, TomlValue>;
}

let tomlCache: TomlCache | null = null;

function settingsTomlPath(): string {
  return process.env.CONDUCTOR_SETTINGS_PATH ?? CONDUCTOR_SETTINGS_PATH_DEFAULT;
}

function conductorDbPath(): string {
  return process.env.CONDUCTOR_DB_PATH ?? CONDUCTOR_DB_PATH_DEFAULT;
}

function readSettingsToml(): Map<string, TomlValue> | null {
  const filePath = settingsTomlPath();
  try {
    const stat = statSync(filePath);
    if (
      tomlCache &&
      tomlCache.path === filePath &&
      tomlCache.mtimeMs === stat.mtimeMs
    ) {
      return tomlCache.values;
    }
    const values = parseSimpleToml(readFileSync(filePath, "utf8"));
    tomlCache = { path: filePath, mtimeMs: stat.mtimeMs, values };
    return values;
  } catch {
    return null;
  }
}

function readSettingFromDb(key: string): string | null {
  try {
    const db = new Database(conductorDbPath(), { readonly: true });
    const row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value?: string } | undefined;
    db.close();
    return typeof row?.value === "string" ? row.value : null;
  } catch {
    return null;
  }
}

/**
 * Read a Conductor setting by its legacy settings-table key. settings.toml
 * wins when it holds a value for the key; the (deprecated) DB row is the
 * fallback so pre-0.72 Conductor installs keep working.
 */
export function getConductorSetting(key: string): string | null {
  const tomlPath = LEGACY_KEY_TO_TOML_PATH[key];
  if (tomlPath) {
    const values = readSettingsToml();
    const value = values?.get(tomlPath);
    if (value !== undefined && value !== "") {
      return String(value);
    }
  }
  return readSettingFromDb(key);
}

/** Whether settings.toml exists and parses to at least one value (doctor). */
export function describeConductorSettingsSource(): {
  tomlPath: string;
  tomlReadable: boolean;
  tomlKeys: number;
} {
  const values = readSettingsToml();
  return {
    tomlPath: settingsTomlPath(),
    tomlReadable: values !== null,
    tomlKeys: values?.size ?? 0,
  };
}
