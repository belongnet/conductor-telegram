# conductor-telegram

Remote oversight for [Conductor](https://conductor.build) workspaces via Telegram. Run AI agents, approve decisions, and monitor progress from your phone.

Built by [Belong.net](https://belong.net)

## Quickstart

```bash
npm i -g conductor-telegram
conductor-telegram setup
conductor-telegram
```

That's it. The setup wizard walks you through Telegram bot creation, configuration, and MCP plugin installation.

## Commands

```
conductor-telegram              Start the bot (foreground)
conductor-telegram setup        Interactive configuration wizard
conductor-telegram doctor       Validate config, token, paths, and connectivity
conductor-telegram status       Show configuration health
conductor-telegram install-plugin  Install MCP server into Claude Code
conductor-telegram help         Show all commands
conductor-telegram --version    Show version
```

## Configuration

Config is stored at `~/.conductor-telegram/config.json` (created by `setup`).

**Precedence:** CLI flags > environment variables > config.json > defaults

| Flag | Env Var | Description |
|------|---------|-------------|
| `--token` | `BOT_TOKEN` | Telegram bot token |
| `--chat-id` | `OWNER_CHAT_ID` | Your Telegram chat ID |
| `--db-path` | `DB_PATH` | SQLite database path |
| | `CONDUCTOR_WORKSPACES_DIR` | Conductor workspaces directory |
| | `CONDUCTOR_REPOS_DIR` | Repository directory |

Existing `.env` files are auto-detected and can be imported during setup.

## MCP Server

The MCP server runs inside Conductor workspaces and gives agents these tools:

- `report_status` -- Report progress back to Telegram
- `report_artifact` -- Report PRs, commits, or files
- `request_human` -- Ask the operator a question via Telegram

Install with `conductor-telegram install-plugin` or during setup.

## Troubleshooting

Run `conductor-telegram doctor` to check all components:

```
$ conductor-telegram doctor

  Node.js     ✓ v22.14.0 (required >=22)
  Config      ✓ ~/.conductor-telegram/config.json (0600)
  Bot token   ✓ @MyBot connected
  Database    ✓ ~/.conductor-telegram/conductor-telegram.db
  Conductor   ✓ ~/Library/Application Support/com.conductor.app/conductor.db
  MCP Plugin  ✓ ~/.claude/plugins/conductor-telegram-mcp installed
  Repos       ✓ ~/conductor/repos (4 repositories)
```

**Common issues:**

- **"Bot token is invalid"**: Token may be revoked. Create a new one with @BotFather and run `conductor-telegram setup`.
- **"better-sqlite3 failed to load"**: Run `npm rebuild better-sqlite3`. If that fails, install Xcode CLI tools: `xcode-select --install`.
- **"Conductor DB not found"**: Install [Conductor](https://conductor.build) or set `conductorDbPath` in config.

## Upgrading

```bash
npm i -g conductor-telegram@latest
conductor-telegram doctor
```

Config is preserved across upgrades. The `doctor` command validates everything still works.

## License

MIT - Built by [Belong.net](https://belong.net)
