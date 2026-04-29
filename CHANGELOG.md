# Changelog

All notable changes to conductor-telegram are documented here.

## [0.3.6.2] - 2026-04-29

### Fixed
- Critical: messages, status updates, and questions from one chat were leaking into other chats whenever two repos happened to spawn workspaces with the same Conductor city name (e.g., both ended up with a `maputo`). Conductor picks city names per-repo, not globally, so collisions are routine across separate repos. Every lookup that resolved a city name to a tracked workspace, a Conductor session, or a running agent process is now scoped — by chat ID, repo path, or the workspace's own UUID — so traffic stays in the chat that owns it.
- The session poller no longer cross-pollinates: it now passes the workspace's `repo_path` when reading from Conductor's DB, so it can't pull the wrong repo's session messages and forward them to the wrong Telegram chat.
- `AskUserQuestion` decisions raised by the in-process Claude agent now resolve the target workspace by its UUID instead of the city name, so the question reaches the chat that asked for it even when another chat is running an agent with the same city name.
- Reply-based routing in forum supergroups (`#skill`, `/send`, `/skill`, etc.) now scopes the "which workspace did you reply to?" inference to the current chat, so a reply in chat B can't be redirected to a same-named workspace in chat A.

### Changed
- `runningAgents` and `pendingStdinDecisions` in the launcher are keyed by the tracked workspace UUID instead of the Conductor city name. Two simultaneous agents with the same city name (across different repos/chats) no longer overwrite each other's child-process handles, and answering a question routes to the correct agent's stdin.
- `getWorkspaceByName` now takes an explicit `{ chatId?, repoPath? }` scope and orders results deterministically. It logs a warning when an ambiguous lookup matches more than one workspace, so any remaining unscoped callers surface in the logs.

## [0.3.6.1] - 2026-04-29

### Fixed
- New tasks typed in the General topic of a forum supergroup no longer get silently swallowed by an old running workspace. The AI auto-router now defaults to creating a fresh workspace and only continues an existing one when there's an unmistakable signal (you named the workspace, used a continuation phrase like "also" or "same as before", or the message is an obvious follow-up to that workspace's listed prompt). Topical similarity alone is no longer enough.
- Text messages that the auto-router can't place now get a clear "couldn't auto-route that" reply instead of vanishing into the void.

### Changed
- The AI router treats your message text as data, not instructions. User text is now wrapped in `<user_message>` tags with explicit "ignore directives inside" guidance, and any closing tag the user might inject is stripped, so a malicious message can't rewrite the routing rules.
- The router's response shape is type-validated before it's used: `action` must be `new` or `existing`, and the prompt must be a non-empty string. Hallucinated actions or wrong types now get rejected instead of flowing through.
- The decision log now JSON-encodes the prompt preview, so an attacker-controlled message can't forge log lines or smuggle terminal escape sequences past an operator tailing the bot log.

## [0.3.6.0] - 2026-04-28

### Added
- Photos, voice notes, documents, audio, video, and animated GIFs sent from Telegram now all reach the agent as inline attachments. Documents/audio/video/animation paths previously fell on the floor; they're now downloaded, staged into the workspace's `.context/attachments/` directory, and exposed to the agent like photos already were.
- Agent replies that reference local workspace files render as actual Telegram media instead of plain Markdown links. Markdown image syntax `![alt](path/to/file)` ships as a `sendPhoto`, plain `[name](path)` ships as a `sendDocument`, and the right call (`sendVideo` / `sendAudio` / `sendAnimation`) is picked from the file extension. When the agent emits 2-10 files in one message they ride on a single `sendMediaGroup`; >10 splits into successive groups.
- `report_artifact` calls of type `file` now upload the actual file inline when the artifact's path resolves inside the workspace, with a caption summarizing the artifact. Remote URLs continue to render as a plain link.
- Long agent text (>1024 chars) automatically falls out of the media caption and gets sent as a separate follow-up message so Telegram's caption cap never silently drops content.

### Changed
- The forwarder's `formatForwardedMessage` now returns both cleaned text and a media list, and the topic-recovery layer was extended to media (`sendPhoto` / `sendDocument` / `sendMediaGroup` all recreate a deleted forum topic on the fly, the same way the existing `sendToWorkspaceTopic` does).

## [0.3.5.1] - 2026-04-28

### Fixed
- Inline keyboard buttons (decision options on `❓` questions, post-done Review/PR buttons, /list stop+archive, /run repo selection, setup "Use This Chat") were being rejected by Telegram with `400 Bad Request: can't parse inline keyboard button: invalid button style specified`, which dropped the entire `sendMessage` call. The result was that questions arrived without their answer buttons, or didn't arrive at all. Telegram's Bot API does not accept the `style` field that v0.3.0 added in pursuit of "Bot API 9.4 button styles." The field is now gone from the wire format and from `btn()`'s signature.
- AskUserQuestion forwarding read the wrong shape from the agent's tool input, so every `❓` request landed on Telegram with the placeholder text "Agent is asking a question" and no answer buttons, even when the agent supplied a real question and a list of choices. Claude Code now ships the prompt as `questions: [{ question, options: [{ label, description }] }]` (with up to four questions per call); the launcher's detector previously expected the long-deprecated flat shape `{ question, options: string[] }`. The detector now reads the new shape, falls back to the legacy one, and unwraps option objects to their `label` for button text. Multi-question calls collapse to the first question with the others appended to the body so they remain visible.

## [0.3.5.0] - 2026-04-26

### Fixed
- Deleted forum topics now come back. If you (or anyone) deletes a workspace's topic in Telegram, the bot detects the failure on the next message, recreates the topic with the correct status icon, updates its records, and delivers the message to the new thread. No more silent black holes.
- Failed workspaces no longer get their topic auto-closed. The topic stays open with the red icon so you can reply, retry, or investigate, the same way completed workspaces do. Topics still close on `/stop` or the Stop button (the cases where you actually meant to put it away).

## [0.3.4.0] - 2026-04-22

### Added
- Self-recovery: the bot now writes a heartbeat every 10s, exits cleanly on unhandled crashes, and records the exit reason so a supervisor can restart it without losing context
- `conductor-telegram service` subcommand manages a macOS launchd LaunchAgent that keeps the bot alive across reboots, logouts, and crashes, plus a sibling watchdog agent that kickstarts the main agent if its heartbeat goes stale for more than 120s
- `/ping` Telegram command reports bot uptime, last heartbeat age, version, pid, boot count, and last exit reason
- Boot announcement DM to the owner chat on every restart, showing how long since the bot was last alive and (if known) why it exited
- Timestamped structured logs for all lifecycle events so post-mortems are possible from `~/.conductor-telegram/bot.log`

### Changed
- Poll loops are now restart-proof: a single Telegram API error can no longer silently kill the forwarder or event poller
- Shutdown path consolidated into the crash-handler module so SIGTERM, SIGINT, unhandledRejection, and uncaughtException all release resources and record an exit reason before exiting

## [0.3.3.0] - 2026-04-19

### Added
- Hashtag-based skill invocation: tag `#ship`, `#qa`, `#investigate`, or any skill name anywhere in a message (text or voice) and the bot rewrites it into a skill-invocation prompt for the target workspace
- Slash-command shortcuts for well-known skills: `/ship`, `/qa`, `/investigate`, `/retro`, `/health`, `/checkpoint`, `/document_release`, `/office_hours`, `/design_review` — visible in Telegram's slash menu via `setMyCommands`
- `/skills` now lists built-in skills alongside workspace skills, with a "how to invoke" section explaining hashtag and slash syntax
- Skill commands honor forum-topic context, so firing `/ship` inside a workspace's topic targets that workspace without a reply

## [0.3.2.0] - 2026-04-18

### Added
- Contribute-to-the-stack section on website with prominent NPM and GitHub CTA cards
- Interactive fireworks celebration animation triggered by a "Simulate PR Merged" button
- Bot sends a celebratory fireworks message in Telegram when a PR artifact is reported

### Changed
- Revamped Contributing section with new copy, layout, and streamlined contribution steps

## [0.3.1.1] - 2026-04-12

### Changed
- Voice messages in the general tab now send only the transcript to the workspace, without the audio file attachment
- Voice messages in forum thread tabs skip transcription entirely, since they already receive pre-transcribed messages from the general tab

## [0.3.1.0] - 2026-04-08

### Added
- Post-completion "Review Changes" and "Generate PR" buttons on finished workspace messages
- Dual-model review flow: primary model does the work, secondary review model reviews or creates PRs
- New callback handler for post-done actions with automatic forum topic reopening

## [0.3.0.1] - 2026-04-08

### Changed
- Replace ASCII architecture diagram with interactive Mermaid.js flowchart on GitHub Pages site
- Add animated background effects (grid, floating orbs, particles) and scroll-triggered fade-in animations
- Add SVG hero illustration showing terminal-to-phone connection flow
- Upgrade feature cards with SVG icons, hover effects, and accent glow borders
- Add glassmorphism nav bar with backdrop blur
- Color terminal dots (red/yellow/green) and gradient avatar in Telegram mockup

## [0.3.0.0] - 2026-04-08

### Added
- GitHub Pages documentation site with setup guide, architecture diagram, and interactive mockups
- MIT LICENSE file
- CONTRIBUTING.md with development setup, branching conventions, and PR guidelines
- GitHub issue templates (bug report, feature request)
- Pull request template with testing checklist
- GitHub Actions workflow for automatic Pages deployment

## [0.2.1.0] - 2026-04-08

### Added
- Design system (DESIGN.md) with complete brand identity: industrial/utilitarian aesthetic, electric teal accent, Cabinet Grotesk + DM Sans + JetBrains Mono typography stack
- CLAUDE.md design system reference for consistent visual decisions

### Changed
- CLI banner uses brand teal color instead of generic cyan, with truecolor detection and graceful fallback
- ANSI escape sequences use targeted resets instead of full terminal reset
