# Changelog

All notable changes to this plugin will be documented here.

## [Unreleased]

### Changed

- **Plugin renamed from `vibecommit-capture` to `vibecommit`** in
  `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`
  (`plugins[0].name`), and `displayName` shortened to `VibeCommit`. This is the
  last of the three colliding names D57 §DX5 split apart: the npm package is
  `@vibe-commit/capture` (D55 — the bare name is taken on npm), the CLI verb
  surface is `vibecommit connect` (shipped with `CR-016`), and the plugin is
  `vibecommit`. `DESIGN.md` §13.6's worked example already prints the
  post-rename path `~/.claude/plugins/vibecommit/bin/vibecommit connect`.
  - The install command is now
    `/plugin install vibecommit@vibecommit-capture`. The marketplace's own
    `name` is a separate identity from the plugin's and is deliberately
    unchanged here.
  - The GitHub repository stays `Vibe-Commit/claude-plugin` (D20, D55 §1) —
    also a separate identity, and correct where it appears in `repository`
    and `homepage`.
  - No `version` bump: `CR-029e` owns version discipline across the three
    editable version fields and the client/plugin skew check.

## [1.0.0] — 2026-05-26

Initial release.

### Added

- `.claude-plugin/plugin.json` — plugin manifest with `name`, `description`,
  `version: "1.0.0"`, `author`, `homepage`, `repository`, `license`
- `.claude-plugin/marketplace.json` — marketplace catalog for
  `/plugin marketplace add Vibe-Commit/claude-plugin`
- `.mcp.json` — MCP server config pointing at `https://api.vibecommit.ai/mcp`
  (Streamable HTTP transport per T4)
- `AGENTS.md` — cross-vendor anchor (append-managed-section per D11/CMT-3);
  content byte-identical to T7's `src/vendors/_shared/agents_md.ts` output
- `CLAUDE.md` — Claude Code project instructions with cooperation-rate-load-bearing
  capture protocol; content byte-identical to T7's `src/vendors/claude_code.ts`
  CLAUDE.md output
- `.claude/skills/vibecommit/SKILL.md` — Claude Code skill for `/vibecommit`
  explicit invocation; content byte-identical to T7's SKILL.md output
- `scripts/verify_t7_parity.sh` — CI-able parity check against T7 source of truth
- `README.md` — install instructions for marketplace users
- `LICENSE` — MIT
- `.gitignore` — minimal Node-style
