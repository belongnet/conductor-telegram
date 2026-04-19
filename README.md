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

## How it works

```
┌──────────────┐     ┌─────────────────┐     ┌─────────────────────┐
│   Telegram   │◄───►│  conductor-     │◄───►│  Conductor          │
│   (you)      │     │  telegram bot   │     │  workspaces/agents  │
└──────────────┘     └────────┬────────┘     └──────────┬──────────┘
                              │                         │
                              │   ┌─────────────────┐   │
                              └──►│   SQLite (WAL)   │◄──┘
                                  └─────────────────┘
                                    shared via MCP
```

The bot polls Conductor sessions every 5 seconds, forwarding agent messages to Telegram. When an agent uses the MCP server to ask a question, the bot surfaces it as an interactive Telegram message with buttons or free-form reply.

## Architecture

```
src/
├── cli/               # CLI entry points
│   ├── index.ts       # Command parser and dispatcher
│   ├── setup.ts       # Interactive configuration wizard
│   ├── config.ts      # Config loading (flags > env > config.json > defaults)
│   ├── doctor.ts      # System validation and diagnostics
│   └── install-plugin.ts  # MCP plugin installer
├── bot/               # Telegram bot
│   ├── index.ts       # Bot init, polling loops, message forwarding
│   ├── commands.ts    # All command and callback handlers
│   ├── launcher.ts    # Agent spawning and session management
│   ├── middleware.ts  # Authentication guard
│   ├── format.ts      # Markdown→HTML, styled buttons, escaping
│   ├── forum.ts       # Forum topic lifecycle
│   └── callback-server.ts  # Webhook/callback handling
├── mcp/               # MCP server (runs inside workspaces)
│   └── server.ts      # report_status, report_artifact, request_human
├── store/             # Database layer
│   ├── db.ts          # SQLite init, schema, migrations
│   └── queries.ts     # CRUD operations
└── types/
    └── index.ts       # TypeScript interfaces
```

## Telegram bot commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/setup` | `/setup` | Check setup diagnostics and apply current chat |
| `/run` | `/run <repo> <prompt>` | Start a new workspace with an AI agent |
| `/review` | `/review <workspace> [instructions]` | Launch a code review session |
| `/send` | `/send <workspace> <message>` | Send a follow-up message to a running agent |
| `/skills` | `/skills [workspace]` | List built-in gstack skills plus workspace skills parsed from CLAUDE.md |
| `/skill` | `/skill <workspace> <name> [instructions]` | Invoke a specific workspace skill |
| `/gstack` | `/gstack <workspace> [instructions]` | Use the GStack/Graphite workflow |
| `/ship`, `/qa`, `/investigate`, `/retro`, `/health`, `/checkpoint`, `/document_release`, `/office_hours`, `/design_review` | `/ship [instructions]` (reply or use inside a topic) | Shortcuts for well-known gstack skills, registered in Telegram's slash menu |
| `/workspaces` | `/workspaces` | List all tracked workspaces |
| `/status` | `/status` | Show active workspace summary |
| `/stop` | `/stop <name>` | Stop a running workspace |
| `/repos` | `/repos` | List available repositories (tap to select) |
| `/help` | `/help` | Show help message |

Three ways to target a workspace with skill or follow-up commands:

1. **Reply** to any forwarded workspace message with `/send`, `/review`, `/skills`, `/skill`, `/gstack`, or any skill shortcut.
2. **Send inside the workspace's forum topic** — skill shortcuts and `/skill` / `/gstack` pick up the topic's workspace automatically.
3. **Hashtag a skill** anywhere in a message (text or voice) — e.g. `#ship fix the failing test` or `can you #qa this flow please`. The bot rewrites the message into a skill-invocation prompt for the target workspace. Voice transcripts are scanned for hashtags too.

Photos, screenshots, and voice notes sent as replies are staged to the workspace for the agent.

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

## CLI commands

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
| | `OWNER_USER_ID` | Your Telegram user ID (required for forum mode) |
| | `CONDUCTOR_WORKSPACES_DIR` | Conductor workspaces directory |
| | `CONDUCTOR_REPOS_DIR` | Repository directory |
| | `CONDUCTOR_DB_PATH` | Conductor's own database path |
| | `TELEGRAM_DEFAULT_AGENT_TYPE` | Default agent: `claude` or `codex` |
| | `TELEGRAM_DEFAULT_MODEL` | Default model for agents |
| | `TELEGRAM_REVIEW_AGENT_TYPE` | Agent type for `/review` sessions |
| | `TELEGRAM_REVIEW_MODEL` | Model for `/review` sessions |
| | `TELEGRAM_AGENT_PERMISSION_MODE` | Permission mode (default: `bypassPermissions`) |

Existing `.env` files are auto-detected and can be imported during setup.

## MCP server

The MCP server runs inside Conductor workspaces and gives agents these tools:

| Tool | Description |
|------|-------------|
| `report_status` | Report progress back to Telegram (status label + message) |
| `report_artifact` | Report a deliverable: PR, commit, or file |
| `request_human` | Ask the operator a question, optionally with button choices |

The `request_human` tool blocks (polls for up to 5 minutes) until the operator answers via Telegram — either by tapping a button or replying with free-form text.

Install with `conductor-telegram install-plugin` or during setup.

## Database

SQLite database at `~/.conductor-telegram/conductor-telegram.db` with WAL mode for concurrent writes from the bot and multiple MCP server instances.

**Tables:**

| Table | Purpose |
|-------|---------|
| `workspaces` | Tracked workspace state, status, repo path, Telegram thread |
| `events` | Status updates, artifacts, and human requests from MCP |
| `decisions` | Questions posed to the operator with answers |
| `telegram_message_links` | Maps Telegram messages to workspaces for reply routing |

## Development

```bash
git clone https://github.com/belongnet/conductor-telegram.git
cd conductor-telegram
npm install

# Run in development mode
npm run dev           # CLI entry point
npm run dev:bot       # Bot directly
npm run dev:mcp       # MCP server

# Build
npm run build

# Type check
npm run typecheck
```

Requires Node.js v22+.

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
