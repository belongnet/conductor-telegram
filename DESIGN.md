# Design System — conductor-telegram

## Product Context
- **What this is:** CLI tool + Telegram bot for remote oversight of AI agent workspaces
- **Who it's for:** Developers and operators managing Conductor workspaces from their phone
- **Space/industry:** Developer tools, AI infrastructure, agent oversight
- **Project type:** CLI tool + Telegram bot (dark-first, terminal + mobile surfaces)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian
- **Decoration level:** Minimal — typography and color do the heavy lifting
- **Mood:** Precise, alert, competent. Mission control for AI agents. The operator is in control, the system reports clearly, nothing is ambiguous.

## Typography
- **Display/Hero:** Cabinet Grotesk — geometric, sharp, slightly condensed. Technical without being cold. Works in ALL CAPS for CLI banner and bot identity.
- **Body:** DM Sans — clean geometric sans, excellent legibility at small sizes. Pairs with Cabinet Grotesk without competing.
- **UI/Labels:** DM Sans (same as body)
- **Data/Tables:** JetBrains Mono — tabular-nums, ligatures, designed for screen. The best monospace for developer tools.
- **Code:** JetBrains Mono
- **Loading:** Google Fonts CDN for web surfaces. System fallback for CLI (monospace only).
- **Scale:** 11px (caption) / 13px (small) / 15px (body) / 17px (lead) / 24px (h2) / 32px (h1) / 48px (display)

## Color
- **Approach:** Restrained — one accent + neutrals, color is rare and meaningful
- **Primary accent:** #00D4AA (electric teal) — "systems online, everything connected." Distinctive vs the purple/violet every AI tool defaults to. High visibility in Telegram dark mode and terminal.
- **Secondary:** #F59E0B (amber) — warning/attention states. Classic signal color.
- **Neutrals (dark-first):**
  - Background: #0A0A0B
  - Surface: #141416
  - Surface raised: #1C1C1F
  - Border: #27272A
  - Border subtle: #1E1E21
  - Muted text: #71717A
  - Dim text: #52525B
  - Primary text: #FAFAFA
- **Semantic:** success #22C55E, warning #F59E0B, error #EF4444, info #3B82F6
- **Dark mode:** Primary surface. This is a dark-first product.
- **Light mode:** Invert neutrals. Background #FAFAFA, surface #FFFFFF, border #E4E4E7. Reduce accent saturation slightly (#00B894).

## Spacing
- **Base unit:** 4px
- **Density:** Compact — this is a monitoring tool, information density matters
- **Scale:** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64)

## Layout
- **Approach:** Grid-disciplined — predictable alignment, clear hierarchy
- **Max content width:** 1120px
- **Border radius:** Minimal. sm:4px, md:6px, lg:8px, full:9999px (badges/pills only)

## Motion
- **Approach:** Minimal-functional — only transitions that aid comprehension
- **Easing:** enter(ease-out) exit(ease-in) move(ease-in-out)
- **Duration:** micro(50-100ms) short(150-250ms) medium(250-400ms)
- **Rule:** No decorative animation. Status changes, loading states, and hover feedback only.

## Brand Identity
- **Name treatment:** "conductor-telegram" in lowercase monospace. The word "conductor" carries the brand, "telegram" is the channel.
- **Logo concept:** The letter "C" in a teal circle, monospace weight. Used as Telegram bot avatar. Simple enough to read at 32px.
- **CLI banner:** Teal "conductor-telegram" + dim "Built by Belong.net" tagline.
- **Telegram avatar:** Teal (#00D4AA) circle with white "C" in Cabinet Grotesk or JetBrains Mono.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-08 | Initial design system created | Created by /design-consultation. Industrial/utilitarian direction chosen to match the product's command-center purpose. |
| 2026-04-08 | Electric teal (#00D4AA) as primary accent | Deliberately avoids the AI-purple cliche. Teal evokes "systems online" and reads well in both terminal and Telegram dark mode. |
| 2026-04-08 | Compact density | Mobile oversight on Telegram means information needs to fit in message bubbles. CLI output is inherently compact. |
