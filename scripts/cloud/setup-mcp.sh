#!/usr/bin/env bash
# Run as the cloud workspace user from its repository directory, in the organization's setup command.
set -euo pipefail
umask 077
: "${TELEGRAM_BRIDGE_URL:?Scoped bridge URL is required}"
: "${TELEGRAM_BRIDGE_TOKEN:?Scoped bridge credential is required}"
TELEGRAM_CLIENT_DIR="${TELEGRAM_CLIENT_DIR:-$HOME/.local/share/conductor-telegram-client}"
export TELEGRAM_CLIENT_DIR
mkdir -p "$TELEGRAM_CLIENT_DIR"
node --input-type=module <<'JS'
import fs from 'node:fs';
const url = new URL(process.env.TELEGRAM_BRIDGE_URL);
if (url.protocol !== 'https:') throw new Error('Cloud bridge requires HTTPS');
const response = await fetch(`${url.origin}/v1/client`, {
  headers: {Authorization: `Bearer ${process.env.TELEGRAM_BRIDGE_TOKEN}`},
  redirect: 'error', signal: AbortSignal.timeout(60000),
});
if (!response.ok) throw new Error(`Client download failed (${response.status})`);
fs.writeFileSync(`${process.env.TELEGRAM_CLIENT_DIR}/client.tgz`, Buffer.from(await response.arrayBuffer()), {mode: 0o600});
JS
npm install --prefix "$TELEGRAM_CLIENT_DIR" --omit=dev --no-audit --no-fund "$TELEGRAM_CLIENT_DIR/client.tgz"
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
const server = {command: process.execPath, args: [`${process.env.TELEGRAM_CLIENT_DIR}/node_modules/conductor-telegram/dist/mcp/remote.js`]};
for (const filename of [path.join(process.env.HOME, '.claude.json'), path.join(process.env.HOME, '.cursor/mcp.json')]) {
  const config = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {};
  config.mcpServers ??= {}; config.mcpServers['conductor-telegram'] = server;
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  fs.writeFileSync(filename, JSON.stringify(config, null, 2) + '\n', {mode: 0o600});
}
const filename = path.join(process.env.HOME, '.codex/config.toml');
let config = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : '';
// Replace only our own generated table, preserving unrelated MCP configuration.
config = config.replace(/^\[mcp_servers\.conductor-telegram\]\n[\s\S]*?(?=^\[|(?![\s\S]))/gm, '');
config += `\n[mcp_servers.conductor-telegram]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nenv_vars = ["TELEGRAM_BRIDGE_URL", "TELEGRAM_BRIDGE_TOKEN"]\n`;
fs.mkdirSync(path.dirname(filename), {recursive: true}); fs.writeFileSync(filename, config, {mode: 0o600});
console.log('Telegram MCP configured for Claude, Codex, and Cursor. No gateway credentials were copied.');
JS
