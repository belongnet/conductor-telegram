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
│   Telegram   │◄───►│  conductor-     │◄───►│  Local Conductor    │
│   (you)      │     │  telegram bot   │     │  workspaces/agents  │
└──────────────┘     └──────┬────┬─────┘     └──────────┬──────────┘
                            │    │                      │
              official API │    │   ┌──────────────┐   │
                            │    └──►│ SQLite (WAL) │◄──┘
                            ▼        └──────────────┘
                    Conductor Cloud
```

The bot polls local Conductor sessions every 5 seconds and Cloud sessions every 15 seconds, forwarding agent messages to Telegram. When an agent uses the MCP server to ask a question, the bot surfaces it as an interactive Telegram message with buttons or free-form reply.

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
│   ├── polling-policy.ts  # Cloud recovery scheduling and notice publication
│   ├── middleware.ts  # Authentication guard
│   ├── format.ts      # Markdown→HTML, styled buttons, escaping
│   ├── forum.ts       # Forum topic lifecycle
│   └── callback-server.ts  # Webhook/callback handling
├── mcp/               # MCP server (runs inside workspaces)
│   └── server.ts      # report_status, report_artifact, request_human
├── store/             # Database layer
│   ├── db.ts          # SQLite init, schema, migrations
│   └── queries.ts     # CRUD operations
├── integrations/
│   └── conductor-api.ts  # Supported Conductor Cloud API transport
├── lanes/
│   ├── config.ts          # Optional lanes.json loading
│   ├── decide.ts          # Pure queue/nudge/create decisions
│   └── scheduler.ts       # Interval tick, API actions, owner notices
└── types/
    └── index.ts       # TypeScript interfaces
```

## Telegram bot commands

| Command | Usage | Description |
|---------|-------|-------------|
| `/setup` | `/setup` | Check setup diagnostics and apply current chat |
| `/run` | `/run <repo> <prompt>` | Start a Cloud-first workspace with a local fallback |
| `/cloud` | `/cloud <project> <prompt>` | Start a ☁️ Conductor Cloud workspace via the API (no local checkout needed) |
| `/projects` | `/projects [name]` | List cloud projects, or one project's recent workspaces |
| `/fleet` | `/fleet [hours]` | Org-wide cloud activity report from transcript search (default 24h, max 168) |
| `/lanes` | `/lanes [run\|pause\|resume]` | Config-driven Cloud lane scheduler: status table, run a tick, or pause/resume |
| `/rename` | `/rename <name>` (inside a topic or as a reply) | Rename the current cloud workspace via the API |
| `/renamethread` | `/renamethread <name>` (inside a topic or as a reply) | Rename the current cloud thread via the API |
| `/review` | `/review <workspace> [instructions]` | Launch a code review session |
| `/send` | `/send <workspace> <message>` | Send a follow-up message to a running agent |
| `/threads` | `/threads [workspace]` | List Conductor threads, switch the default thread, or start a new thread |
| `/skills` | `/skills [workspace]` | List built-in gstack skills plus workspace skills parsed from CLAUDE.md or AGENTS.md |
| `/skill` | `/skill <workspace> <name> [instructions]` | Invoke a specific workspace skill |
| `/gstack` | `/gstack <workspace> [instructions]` | Use GStack skills (ship, qa, browse, etc.) |
| `/ship`, `/qa`, `/investigate`, `/retro`, `/health`, `/checkpoint`, `/document_release`, `/office_hours`, `/design_review` | `/ship [instructions]` (reply or use inside a topic) | Shortcuts for well-known gstack skills, registered in Telegram's slash menu |
| `/workspaces` | `/workspaces` | List all tracked workspaces |
| `/prs`, `/ship_status` | `/prs` | Show PR, check, merge, and stale-branch status for tracked workspaces |
| `/decisions` | `/decisions` | Show unanswered agent questions for this chat |
| `/status` | `/status` | Show active workspace summary |
| `/ping` | `/ping` | Bot liveness check (uptime, heartbeat, version) |
| `/stop` | `/stop <name>` | Stop a running workspace |
| `/repos` | `/repos` | List available repositories (tap to select) |
| `/help` | `/help` | Show help message |

Ways to target work from Telegram:

1. **Reply** to any forwarded workspace message with text, media, `/send`, `/review`, `/skills`, `/skill`, `/gstack`, or any skill shortcut. If that message came from a specific Conductor thread, the reply goes back to that exact thread.
2. **Send inside the workspace's forum topic** — skill shortcuts and `/skill` / `/gstack` pick up the topic's workspace automatically. Plain messages go to the workspace's active Conductor thread.
3. **Send inside a repo topic** — in forum mode, tap **Topic** beside a repo in `/repos` to create a durable repo topic. Text, photos, screenshots, generic files, and voice notes sent there start a new workspace for that repo without guessing from the message.
4. **Hashtag a skill** anywhere in a message (text or voice) — e.g. `#ship fix the failing test` or `can you #qa this flow please`. The bot rewrites the message into a skill-invocation prompt for the target workspace. Voice transcripts are scanned for hashtags too.

Conductor 0.72+ threads are mirrored into the same Telegram workspace topic. When a workspace has multiple visible Conductor sessions, forwarded messages include a `🧵` thread label. Use `/threads` in the topic to switch the active thread or start a new one.

Conductor Cloud workspaces use [Conductor's official API](https://www.conductor.build/docs/api) when `CONDUCTOR_API_KEY` is configured. Telegram can create cloud workspaces (`/cloud`), browse projects (`/projects`), send messages, create ordinary threads, poll transcripts/status, rename workspaces and threads, search org-wide transcripts (`/fleet`), cancel sessions, and archive workspaces without writing Conductor's private database. Without an API key, cloud workspaces remain observe-only through the desktop app's local mirror.

Cloud workspaces created with `/cloud` are driven entirely over the API — discovery, prompt delivery, and polling work even when the Conductor desktop app is closed or absent. Project arguments to `/cloud` and `/projects` accept a list number from `/projects`, a project id, an exact name, or a unique name prefix. When the bot itself runs inside a Conductor cloud workspace, it honors `CONDUCTOR_API_URL` and attributes its requests via an `X-Conductor-Session-Id` header taken from `CONDUCTOR_SESSION_ID` — both injected by the cloud workspace environment, not user config.

Repo-targeted Telegram launches are Cloud-first. `/run`, repo-topic messages, and AI-routed new tasks use Cloud automatically when `CONDUCTOR_API_KEY` is configured and exactly one Cloud project matches the local repository's `origin` URL (SSH and HTTPS forms are treated as the same repository). Missing or ambiguous origins always fall back locally; automatic routing never guesses from a project name or remote basename. The bot states when it falls back to a local workspace because Cloud is unconfigured, project lookup failed, no project matched, or Telegram attachments require the local file bridge. `/cloud` remains available when you want to choose a Cloud project explicitly.

If a local prompt later fails because its CLI login disappeared, the bot can take the same Telegram workspace over through Cloud. Automatic replay is limited to launcher-confirmed startup authentication failures before any assistant or tool activity. The worktree must be clean and its exact commit must already exist on an `origin` branch; the bot rechecks that branch after Cloud provisioning and before it sends work. Because the public Cloud API does not expose the provisioned checkout SHA, the handoff carries the expected SHA and tells the Cloud agent to verify HEAD before any side effect. Dirty files, unpushed commits, and partially executed prompts are never silently replayed. The Cloud binding and first prompt are persisted as a recoverable pending launch before delivery; later overlapping requests use a durable, ordered outbox with stable message identities. Stop intent and uncertain cleanup also survive restarts, so a canceled pending launch cannot be replayed later. A Stop or Archive the API rejects is retried across restarts, but only until it is clearly hopeless: because a pending terminal request blocks later sends, one that cannot succeed is retired with an explanatory message rather than gating the workspace forever. Restricted read-only reviews remain local until the public Cloud API exposes equivalent permission-policy enforcement.

Cloud commands act on your whole Conductor organization with the configured `CONDUCTOR_API_KEY`. In a group chat, set `OWNER_USER_ID` so only you can create (`/cloud`), rename, or query (`/projects`, `/fleet`) org resources — without it, every member of the configured group shares that privilege.

The official API is still beta. Cloud operations therefore use runtime response and resource-identity validation, bounded retries only for idempotent requests, throttled non-overlapping polls, and persisted message-ID cursors that are never mixed with desktop SQLite row IDs. Enforced review permission policies are not exposed by the API, so cloud `/review` attempts fail closed.

Photos, screenshots, voice notes, and audio files sent as replies are staged or transcribed for the agent. General-topic messages that the bot can only infer now ask for confirmation before starting or routing work.

## Lanes scheduler

An optional in-process scheduler keeps at most one working Cloud lane per configured provider, using that provider's model, from an ordered queue with dependencies. It is inert unless a config file is present at `LANES_CONFIG` or `~/.conductor-telegram/lanes.json`. Copy `docs/lanes.example.json` and replace the placeholders (`L1`, `https://github.com/example-org/example-repo`, example model ids).

Each tick (every `intervalMinutes`, and on `/lanes run`) looks up workspaces named `[lane:<id>:…`, or an explicit `sessionId` / `workspaceId`. A lane is **working** when its session status is `working`, **done** when any agent transcript event contains a GitHub pull-request URL, **initializing** when no user message has been recorded yet, **paused** when it exists and is idle but not done, and **not created** otherwise. Providers under `maxActive` either nudge the first paused, dependency-ready lane whose last user message is older than `gapHours`, or create the first not-created lane for that provider (or `"any"`). Initializing lanes are never nudged. Failed creates and nudges are logged and the tick moves on.

`/lanes` is owner-only through the existing auth middleware. `/lanes pause` / `/lanes resume` set a process-global flag in SQLite. Each create, nudge, or failure sends a one-line notice to the owner chat.

Prompt paths in the config are relative to the config file's directory.

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

New workspaces will create one forum topic per workspace automatically. Repo topics can also be created from `/repos` and reused as stable launch pads for that repository. If topic creation fails because the chat is not a forum or the bot lacks permissions, the bot falls back to normal chat messages.

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
| `--doppler-project` | `CONDUCTOR_TELEGRAM_DOPPLER_PROJECT` | Doppler project used by foreground and launchd runtimes |
| `--doppler-config` | `CONDUCTOR_TELEGRAM_DOPPLER_CONFIG` | Doppler config used by foreground and launchd runtimes |
| | `OWNER_USER_ID` | Your Telegram user ID (required for forum mode) |
| | `CONDUCTOR_WORKSPACES_DIR` | Conductor workspaces directory |
| | `CONDUCTOR_REPOS_DIR` | Repository directory |
| | `CONDUCTOR_DB_PATH` | Conductor's own database path |
| | `TELEGRAM_DEFAULT_AGENT_TYPE` | Default agent: `claude` or `codex` |
| | `TELEGRAM_DEFAULT_MODEL` | Default model for agents |
| | `TELEGRAM_REVIEW_AGENT_TYPE` | Agent type for `/review` sessions |
| | `TELEGRAM_REVIEW_MODEL` | Model for `/review` sessions |
| | `TELEGRAM_AGENT_PERMISSION_MODE` | Legacy Claude permission mode (default: `acceptEdits`) |
| | `CONDUCTOR_API_BASE_URL` | Conductor API origin (default: `https://api.conductor.build`) |
| | `CONDUCTOR_API_KEY` | Bearer API key for supported Conductor Cloud operations |
| | `CONDUCTOR_CLOUD_BACKEND` | `auto` (use API when keyed), `api` (require key), or `off` |
| | `LANES_CONFIG` | Path to the optional lanes scheduler JSON (default `~/.conductor-telegram/lanes.json`) |
| | `TELEGRAM_WHISPER_MODEL` | whisper.cpp model name or path (default: `base`) |

Conductor app settings are read from `~/.conductor/settings.toml` first, with the legacy Conductor DB `settings` table as fallback. The bot uses Conductor's default/review model settings, Codex thinking levels, Claude effort levels, and git branch prefix settings when Telegram-specific env vars are not set.

To keep runtime secrets in Doppler, persist only the non-secret project/config references:

```bash
conductor-telegram service install \
  --doppler-project <project> \
  --doppler-config <config>
conductor-telegram doctor
```

The installer verifies the persistent Doppler identity available to launchd, removes each Doppler-managed value from `config.json`, and writes a plist containing only the Doppler executable, project/config references, and an explicit allowlist of secret names—not secret values or a Doppler service token. The allowed names are `BOT_TOKEN`, `OWNER_CHAT_ID`, `OWNER_USER_ID`, `CONDUCTOR_API_BASE_URL`, `CONDUCTOR_API_KEY`, and `CONDUCTOR_CLOUD_BACKEND`. Use `BOT_TOKEN` exactly; `TELEGRAM_BOT_TOKEN` is not an alias.

`start`, `status`, and `doctor` automatically re-enter the configured Doppler runtime. Run `service install` again after adding a new allowed secret name. A value-only rotation needs only a service restart.

If Doppler is not configured, keep `CONDUCTOR_API_KEY` only in the bot's mode-`0600` config file or service environment. It is excluded from child-agent environments and must not be copied into repositories, Conductor workspace environment variables, prompts, or MCP configuration.

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
| `thread_cursors` | Per-Conductor-session forwarding cursors for thread fan-out |
| `bot_heartbeat` | Process liveness, boot count, and last exit details |
| `meta` | Durable Cloud launches, ordered messages, stop/archive intents, work leases, recovery notices, and the lanes pause flag |
| `pr_records` | GitHub PR/check/merge state verified by repo + branch |
| `merge_intents` | Expiring requester-bound confirmations for an exact PR head SHA |
| `repo_topics` | Durable Telegram forum topics mapped to repos for no-guess launch routing |
| `route_attempts` | Redacted routing audit log for routed, failed, confirmed, and cancelled attempts |
| `lane_actions` | Create/nudge history for the optional lanes scheduler |

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

# Run tests
npm test
```

Requires Node.js v22+. See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, commit style, and PR guidelines.

## Troubleshooting

Run `conductor-telegram doctor` to check all components:

```
$ conductor-telegram doctor

  Node.js     ✓ v22.14.0 (required >=22)
  Config      ✓ ~/.conductor-telegram/config.json (0600)
  Bot token   ✓ @MyBot connected
  Database    ✓ ~/.conductor-telegram/conductor-telegram.db
  Conductor   ✓ ~/Library/Application Support/com.conductor.app/conductor.db
  Conductor Cloud API  ✓ api-key authenticated; 3 cloud project(s) visible
  GitHub CLI  ✓ gh version 2.x.x
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

Config is preserved across upgrades. The `doctor` command validates everything still works. Release notes live in [CHANGELOG.md](CHANGELOG.md).

## Mac gateway deployment

A gateway host keeps itself current. Enrolling is opt-in:

```bash
conductor-telegram service install --with-updater
```

This registers a third LaunchAgent, `net.belong.conductor-telegram.updater`, alongside the bot and its watchdog (a plain `service install` never enrolls you — published-package users keep the normal `npm i -g conductor-telegram@latest` upgrade contract). Every minute the agent fetches `origin/main` into a canonical checkout at `~/.conductor-telegram/gateway/repo` (cloning it on first run, so a fresh machine self-bootstraps), and whenever the remote moves it redeploys:

```bash
scripts/gateway-update.sh       # the poller — copied to ~/.conductor-telegram/bin/ at install
scripts/deploy-mac-gateway.sh   # the deploy it triggers
```

Each deploy runs the Node 22 typecheck/tests/build in the checkout, then packs a release tarball and installs *that* globally — the live gateway is a copy, so nothing the deploy does to the checkout (git reset, `npm ci`) can touch running code before all gates pass. Only then does it reinstall and restart the launchd service and run `doctor` as a configuration/connectivity gate. A failure before the install step leaves the previous gateway untouched and running; a failure at the doctor stage means the new build is already live and gets retried. Failed revisions retry on a 30-minute backoff until a new push lands. Deploys have a hard 40-minute timeout, refuse non-fast-forward (force-pushed) branch tips, and report success/failure straight to the owner's Telegram chat when the bot token is in `config.json`. All three agents are `RunAtLoad`, so a reboot restarts the bot and immediately catches up on any pushes it slept through. Progress lands in `~/.conductor-telegram/update.log`; `service status` shows the deployed revision; `service stop` is respected — auto-deploys will not resurrect a bot the operator stopped.

Polling means no self-hosted runner, no inbound webhook, and no GitHub credentials on the machine — the repo is public, so the updater fetches anonymously. Note the flip side: enrolling a machine means anyone who can push to `main` can run code on it within a minute. Saved Doppler project/config references survive each reinstall, so deployment never needs to materialize secret values in the checkout or launchd plist.

Updater environment overrides, baked into the agent when set at `service install --with-updater` time: `CONDUCTOR_TELEGRAM_GATEWAY_HOME` (state + checkout root, default `~/.conductor-telegram/gateway`), `CONDUCTOR_TELEGRAM_GATEWAY_REMOTE` (git URL), `CONDUCTOR_TELEGRAM_GATEWAY_BRANCH` (default `main`), `CONDUCTOR_TELEGRAM_GATEWAY_LOG` (default `~/.conductor-telegram/update.log`).

## License

MIT - Built by [Belong.net](https://belong.net)
