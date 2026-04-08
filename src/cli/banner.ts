/**
 * Startup banner for conductor-telegram.
 * Built by Belong.net — conductor.build
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const noColor =
  process.env.NO_COLOR !== undefined || process.argv.includes("--no-color");

function dim(s: string): string {
  return noColor ? s : `\x1b[2m${s}\x1b[0m`;
}
function teal(s: string): string {
  return noColor ? s : `\x1b[38;2;0;212;170m${s}\x1b[0m`;
}

function getVersion(): string {
  try {
    // Walk up from dist/cli/banner.js or src/cli/banner.ts to find package.json
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? "0.0.0";
      }
      dir = path.dirname(dir);
    }
  } catch {}
  return "0.0.0";
}

export function printBanner(statusLine?: string): void {
  const isTTY = process.stdout.isTTY;
  const quiet = process.argv.includes("--quiet");

  if (!isTTY || quiet) return;

  const version = getVersion();
  console.log();
  console.log(`  ${teal("conductor-telegram")} v${version}`);
  console.log(dim("  Built by Belong.net · conductor.build"));
  if (statusLine) {
    console.log();
    console.log(`  ${statusLine}`);
  }
  console.log();
}

export function getVersionString(): string {
  return `conductor-telegram v${getVersion()} · Built by Belong.net`;
}
