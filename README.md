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

## Manual Telegram setup

If you want to configure the bot manually instead of using the CLI wizard, the bot supports two operating modes:

- Private chat mode: talk to the bot directly in a one-on-one chat.
- Forum topic mode: run the bot in a Telegram supergroup with Topics enabled so each workspace gets its own topic.

### Private chat mode

1. Create a bot with BotFather and copy the token into `BOT_TOKEN`.
2. Temporarily set `OWNER_CHAT_ID=0`.
3. Start the bot.
4. Open a direct chat with the bot and send `/start` or `/setup`.
5. If the bot shows a `Use This Chat` button, tap it. The bot will save this private chat automatically.
6. Leave `OWNER_USER_ID` empty.
7. Restart the bot only if you are running it with hardcoded env vars outside the CLI.

### Forum topic mode

Add the bot to your target group, make it admin, then run setup in that group.

1. Create a Telegram supergroup.
2. Enable `Topics` in the supergroup settings.
3. Add the bot to the supergroup.
4. Promote the bot to admin with permission to create/manage topics and send messages.
5. Temporarily set `OWNER_CHAT_ID=0` and `OWNER_USER_ID=0`.
6. Start the bot.
7. Send `/setup` in the target supergroup.
8. If the bot shows a `Use This Chat` button, tap it. The bot will save this supergroup and your Telegram user automatically.
9. Restart the bot only if you are running it with hardcoded env vars outside the CLI.

New workspaces will create one forum topic per workspace automatically. If topic creation fails because the chat is not a forum or the bot lacks permissions, the bot falls back to normal chat messages.

If the bot is already configured for your private chat, you can also add it to a new group and send `/setup` there from the same Telegram account. The bot will show what is missing and can switch itself into group/forum mode from that chat without first resetting `OWNER_CHAT_ID`.

### Bootstrap mode

When `OWNER_CHAT_ID=0`, the bot temporarily allows `/start`, `/help`, and `/setup` before auth is configured. This is the intended bootstrap mode for letting the bot configure the active chat for you.
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
