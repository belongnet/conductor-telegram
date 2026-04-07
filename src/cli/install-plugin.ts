/**
 * MCP plugin installer for conductor-telegram.
 * Resolves the global npm executable path and writes Claude Code plugin config.
 * Built by Belong.net — conductor.build
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { exitWithError, EXIT_GENERAL } from "./errors.js";

const PLUGIN_DIR = path.join(
  os.homedir(),
  ".claude/plugins/conductor-telegram-mcp"
);

function resolveMcpBinary(): string {
  // Try `which` first — works across npm/pnpm/nvm/asdf
  try {
    const result = execSync("which conductor-telegram-mcp", {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}

  // Fallback: resolve relative to our own binary
  const selfPath = process.argv[1];
  if (selfPath) {
    const dir = path.dirname(selfPath);
    const sibling = path.join(dir, "conductor-telegram-mcp");
    if (fs.existsSync(sibling)) return sibling;

    // Try dist layout: dist/cli/index.js -> dist/mcp/server.js
    const distMcp = path.resolve(dir, "..", "mcp", "server.js");
    if (fs.existsSync(distMcp)) return distMcp;
  }

  return "";
}

export async function runInstallPlugin(): Promise<void> {
  const mcpPath = resolveMcpBinary();

  if (!mcpPath) {
    exitWithError(
      "Could not locate conductor-telegram-mcp binary",
      "The MCP server binary was not found in PATH or relative to this executable",
      "Ensure conductor-telegram is installed globally: npm i -g conductor-telegram",
      EXIT_GENERAL
    );
  }

  // Determine if we should use node + path or direct binary
  const isJsFile = mcpPath.endsWith(".js") || mcpPath.endsWith(".mjs");
  const command = isJsFile ? "node" : mcpPath;
  const args = isJsFile ? [mcpPath] : [];

  // Create plugin directory
  const pluginMetaDir = path.join(PLUGIN_DIR, ".claude-plugin");
  fs.mkdirSync(pluginMetaDir, { recursive: true });

  // Write plugin.json
  const pluginJson = {
    name: "conductor-telegram-mcp",
    description:
      "MCP server for Telegram bot oversight of Conductor workspaces. Provides report_status, report_artifact, and request_human tools.",
    version: "0.2.0",
  };
  fs.writeFileSync(
    path.join(pluginMetaDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2) + "\n"
  );

  // Write .mcp.json
  const mcpJson = {
    mcpServers: {
      "conductor-telegram": {
        command,
        args,
      },
    },
  };
  fs.writeFileSync(
    path.join(PLUGIN_DIR, ".mcp.json"),
    JSON.stringify(mcpJson, null, 2) + "\n"
  );

  // Create DB directory
  fs.mkdirSync(path.join(os.homedir(), ".conductor-telegram"), {
    recursive: true,
  });

  // Validate
  const mcpJsonPath = path.join(PLUGIN_DIR, ".mcp.json");
  if (!fs.existsSync(mcpJsonPath)) {
    exitWithError(
      "Plugin installation failed",
      `Could not write to ${mcpJsonPath}`,
      "Check write permissions on ~/.claude/plugins/",
      EXIT_GENERAL
    );
  }

  console.log(`  Plugin installed to: ${PLUGIN_DIR}`);
  console.log(`  MCP server: ${command} ${args.join(" ")}`.trim());
  console.log();
  console.log(
    "  Restart Claude Code or open a new Conductor workspace to use the MCP tools."
  );
  console.log();
  console.log("  Available tools:");
  console.log("    report_status   — Report progress back to Telegram");
  console.log("    report_artifact — Report PRs, commits, or files");
  console.log(
    "    request_human   — Ask the operator a question via Telegram"
  );
}
