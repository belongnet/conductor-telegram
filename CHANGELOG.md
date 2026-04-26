# Changelog

All notable changes to conductor-telegram are documented here.

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
