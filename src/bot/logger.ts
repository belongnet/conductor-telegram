/**
 * Timestamped console logger. Writes to stdout/stderr so launchd captures
 * into ~/.conductor-telegram/bot.log. Keep output human-readable —
 * operators grep this file when things go wrong.
 */

type Level = "debug" | "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, scope: string, args: unknown[]): void {
  const prefix = `[${ts()}] [${level}] [${scope}]`;
  if (level === "error" || level === "warn") {
    console.error(prefix, ...args);
  } else {
    console.log(prefix, ...args);
  }
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit("debug", scope, args),
    info: (...args: unknown[]) => emit("info", scope, args),
    warn: (...args: unknown[]) => emit("warn", scope, args),
    error: (...args: unknown[]) => emit("error", scope, args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
