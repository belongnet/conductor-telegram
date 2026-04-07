/**
 * Structured error formatting for conductor-telegram CLI.
 * Built by Belong.net — conductor.build
 */

export const EXIT_SUCCESS = 0;
export const EXIT_GENERAL = 1;
export const EXIT_CONFIG = 2;
export const EXIT_NETWORK = 3;

const noColor =
  process.env.NO_COLOR !== undefined || process.argv.includes("--no-color");

function red(s: string): string {
  return noColor ? s : `\x1b[31m${s}\x1b[0m`;
}
function dim(s: string): string {
  return noColor ? s : `\x1b[2m${s}\x1b[0m`;
}

export function formatError(error: string, cause: string, fix: string): string {
  return [
    red(`ERROR: ${error}`),
    dim(`CAUSE: ${cause}`),
    `FIX:   ${fix}`,
  ].join("\n");
}

export function exitWithError(
  error: string,
  cause: string,
  fix: string,
  code: number = EXIT_GENERAL
): never {
  console.error(formatError(error, cause, fix));
  process.exit(code);
}

export function exitWithConfigError(
  error: string,
  cause: string,
  fix: string
): never {
  exitWithError(error, cause, fix, EXIT_CONFIG);
}

export function exitWithNetworkError(
  error: string,
  cause: string,
  fix: string
): never {
  exitWithError(error, cause, fix, EXIT_NETWORK);
}
