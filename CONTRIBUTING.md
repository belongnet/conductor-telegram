# Contributing to conductor-telegram

Thanks for your interest. conductor-telegram is MIT licensed and open to contributions of all sizes.

## Quick start

```bash
git clone https://github.com/belongnet/conductor-telegram.git
cd conductor-telegram
npm install
npm run dev        # Start with live reload
npm run typecheck  # Check types before committing
```

## Development

The project has three entry points:

- `src/cli/` — CLI tool (setup wizard, doctor, config)
- `src/bot/` — Telegram bot (commands, middleware, formatting)
- `src/mcp/` — MCP server (report_status, report_artifact, request_human)

Run `npm run dev` to start the CLI in development mode. You'll need a `BOT_TOKEN` from [@BotFather](https://t.me/BotFather) and a running [Conductor](https://conductor.build) instance.

## Branching

- Create a feature branch from `main`: `git checkout -b feat/your-feature`
- Bug fixes: `git checkout -b fix/description`
- Keep PRs focused. One feature or fix per PR.

## Commit messages

Use conventional commits:

```
feat: add workspace filtering by repo
fix: handle missing forum topic gracefully
chore: update dependencies
docs: add MCP server documentation
```

## Code style

- TypeScript, strict mode
- ESM modules (`"type": "module"` in package.json)
- Node.js >= 22
- Run `npm run typecheck` before opening a PR

## Design system

Read `DESIGN.md` before making any visual changes. All colors, fonts, and spacing are defined there. Don't deviate without discussion.

## Pull requests

1. Fork the repo and create your branch from `main`
2. Make your changes
3. Run `npm run typecheck`
4. Open a PR with a clear description of what changed and why
5. Link any related issues

## Reporting bugs

Open an issue with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Output of `conductor-telegram doctor`

## Feature requests

Open an issue describing:
- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
