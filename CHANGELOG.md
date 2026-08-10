# Changelog

All notable changes to this plugin will be documented here.

## [Unreleased]

### Added

- **`hooks/hooks.json`** — the plugin's first deterministic-capture wiring.
  Registers the three events `DESIGN.md` §13.7 names — `Stop`, `PreCompact`,
  `SessionEnd` — each invoking the capture binary with `hook` as its first
  argument, which is what selects the hook exit contract (exit 0 on every path,
  empty stderr, at most one `systemMessage` on stdout) over interactive CLI
  semantics. `.mcp.json` is untouched; the cooperative and deterministic paths
  coexist during the refactor.
- **`bin/` — the capture binary, vendored and committed.** 23 emitted `.js`
  files, 139,807 bytes, built from `vibecommit-capture` commit
  `8e772f181194e94a14fad412482f4a123acef135` with that repo's own
  `npm ci && npm run build`. The hooks now invoke
  `${CLAUDE_PLUGIN_ROOT}/bin/index.js` instead of resolving the package at run
  time: `npx` on every `Stop` is a per-turn cold-fetch tax on every turn of
  every session (D57 §DX2).
  - The **whole emitted tree** ships, not just the entry: the client is
    multi-file ESM with relative imports, so a lone `index.js` cannot resolve
    its own siblings. The client declares **no runtime dependencies**, so the
    tree is self-contained and no `node_modules` is vendored.
  - Source maps and `.d.ts` declarations are **excluded** — they point at `src/`
    paths that do not exist here and roughly triple the bundle.
  - The bundle contains the capture client's own emitted output and nothing
    else (D1a / D60 §D6): this repo is MIT and public, and lifting closed
    `vibecommit-mcp` code into it would relicense that code by accident.
- **`scripts/vendor_capture_bin.sh`** — reproduces `bin/` from a named capture
  commit, so the bundle can be rebuilt and compared rather than taken on trust
  (D64). Builds in a throwaway clone, ships only `.js`, and gates on: nothing
  but `.js` present, the tree byte-identical to `dist/` at that commit, every
  import resolving to a `node:` builtin or a file inside `bin/`, and the entry
  actually running. **Manual by design** — CI vendoring, the `X-Client-Version`
  header and the client/plugin skew check are `CR-029e`.

### Changed

- **Explicit `timeout` on every registered hook event**, in **seconds**:
  `Stop` 8, `PreCompact` 8, `SessionEnd` 10. Claude Code otherwise gives
  `SessionEnd` hooks a shared 1.5 s budget, which is not enough to settle,
  re-read and POST. Every value is strictly above the client's own 5 s
  watchdog (`DEFAULT_HOOK_BUDGET_MS`), which must stay the smaller of the two
  or it never fires — below that line the platform kills the process before the
  client can exit 0. They are otherwise kept as low as that floor allows: the
  client's watchdog is a timer and cannot interrupt a synchronous block, so on
  that path this number is the only thing that ends the hang and it is
  wall-clock a developer waits (D56 §D8).
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
