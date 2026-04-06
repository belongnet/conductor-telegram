#!/bin/bash
# Install the conductor-telegram MCP server as a Claude Code plugin.
# This makes the MCP tools (report_status, report_artifact, request_human)
# available to all Claude Code sessions in Conductor workspaces.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PLUGIN_DIR="$HOME/.claude/plugins/conductor-telegram-mcp"

echo "Installing conductor-telegram MCP plugin..."

# Build the project first
echo "Building..."
cd "$PROJECT_DIR"
npm run build

# Create plugin directory
mkdir -p "$PLUGIN_DIR/.claude-plugin"

# Create plugin.json
cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" << 'EOF'
{
  "name": "conductor-telegram-mcp",
  "description": "MCP server for Telegram bot oversight of Conductor workspaces. Provides report_status, report_artifact, and request_human tools.",
  "version": "0.1.0"
}
EOF

# Create .mcp.json pointing to our built MCP server
cat > "$PLUGIN_DIR/.mcp.json" << EOF
{
  "mcpServers": {
    "conductor-telegram": {
      "command": "node",
      "args": ["$PROJECT_DIR/dist/mcp/server.js"]
    }
  }
}
EOF

# Create the DB directory
mkdir -p "$HOME/.conductor-telegram"

echo ""
echo "Plugin installed to: $PLUGIN_DIR"
echo "MCP server: $PROJECT_DIR/dist/mcp/server.js"
echo "Database: ~/.conductor-telegram/conductor-telegram.db"
echo ""
echo "Restart Claude Code or open a new Conductor workspace to use the MCP tools."
echo ""
echo "Available tools:"
echo "  - report_status: Report progress back to Telegram"
echo "  - report_artifact: Report PRs, commits, or files"
echo "  - request_human: Ask the operator a question via Telegram"
