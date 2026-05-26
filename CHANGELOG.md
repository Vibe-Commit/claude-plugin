# Changelog

All notable changes to this plugin will be documented here.

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
