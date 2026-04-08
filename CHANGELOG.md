# Changelog

All notable changes to conductor-telegram are documented here.

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
