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
- **`bin/` — the capture binary, vendored and committed.** The emitted `.js`
  tree of `vibecommit-capture`, built with that repo's own
  `npm ci && npm run build` at the commit recorded in `capture-bundle.json`
  (the sha lives there and nowhere else — see `CR-029e` below). The hooks now
  invoke `${CLAUDE_PLUGIN_ROOT}/bin/index.js` instead of resolving at run
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
  actually running. **Running it stays manual** — it needs the capture source,
  which this repo may not read — but `CR-029e` below made the resulting drift
  visible, which is the half that could rot unattended.
- **`capture-bundle.json` — the pin, as data (`CR-029e`).** The capture commit
  `bin/` was built from, plus a `sha256` digest and a per-file hash of the
  vendored tree. It had been recorded twice, as a shell default in
  `vendor_capture_bin.sh` and again in this changelog's prose, and two editable
  copies of one fact is exactly the defect `check-version-skew.mjs` exists to
  prevent in the client. Both now derive from this file, and
  `check_bundle.mjs` fails if a second copy of the live sha reappears anywhere
  in the repo.
- **`.github/workflows/bundle.yml` — three gates on every pull request
  (`CR-029e`).** Before this, the only workflow here was `license-check.yml`,
  whose single step is `test -f LICENSE`; the bundle had drifted **nine capture
  commits** behind `main` — shipping a client with no `redact.js` at all — and
  nothing in the repo could have said so.
  - **`scripts/check_bundle.mjs`** — self-consistency, needing no source tree,
    no registry and no credential, which is what lets it run on every PR:
    nothing but `.js` in `bin/`, the entry present, the **import closure**
    (every specifier resolves to `node:` or to a file *inside* `bin/` — D1a
    stated as something a machine can check), the entry actually running a
    `hook` invocation **under a hard timeout** (a blocked hook does not fail,
    it hangs — D90), the tree matching the pin file-by-file, and the pinned
    commit appearing in exactly one place.
  - **`scripts/check_bundle_pin.mjs`** — `bin/` and its pin move **together**.
    The two halves of drift fail in opposite directions and only one is visible
    without history: a pin that moves while `bin/` stands still is perfectly
    self-consistent and completely wrong, so this one reads the merge base.
  - **`scripts/check_npm_bundle.mjs`** — corroboration against the **published**
    tarball, which needs no credential because the package publishes
    `--access public`, and verifies the registry signature D64 kept when it
    dropped `--provenance`. ⚠ **It skips today, loudly**: the package has never
    been published (D64), and the check says so in the job summary rather than
    passing in silence. "Not published" (a declared state) and "the registry
    could not be reached" (an outage) exit **differently** — an empty result
    that reads as clean is the failure this replaces.
  - What CI **cannot** do is rebuild the bundle from source:
    `vibecommit-capture` is private (D64) and this repo is public
    non-negotiably (D20), so a
    cross-org read credential here would invert the licensing boundary the
    bundle's gates exist to protect. Byte-identity against a fresh build stays
    in `vendor_capture_bin.sh`, run by hand where the source is in reach.
- **`.github/workflows/capture-release.yml` — the receiver (`CR-029e`).**
  Capture's `ci.yml` has POSTed `capture-release` with
  `client_payload.version` to this repo on every tag build; nothing listened, so
  it returned 204 and did nothing. The receiver compares `bin/` against the
  released client and, on anything short of a clean match, **files an issue and
  fails the run** — never a silent skip, because at that moment the bundle
  every plugin user installs has just become the old client.

### Changed

- **The three rules files no longer teach retired tools (`CR-079e`).**
  `AGENTS.md`, `CLAUDE.md` and `.claude/skills/vibecommit/SKILL.md` are
  delivered into a user's project on install and read by their agent on every
  task, so a tool name here is an instruction, not a note. The capture-history
  listing tool and the deprecation line for the superseded single-shot capture
  tool are both gone — `CR-076` drops the `traces` table they read, and a rules
  file naming a tool the server no longer registers spends a tool call to find
  that out.
  - **No retired name is left behind to explain itself, and that is
    deliberate.** Spelling the dead tools out in the text that replaces them
    would re-teach the exact strings this change removes, and would trip
    `CR-080`'s cross-repo grep gate from inside the file documenting the
    removal. The successor is named where the agent actually meets the
    problem: `CR-081` makes a retired tool return a structured migration
    error, and step 3 of the capture protocol now tells the agent to call the
    tool that error names instead of retrying the one that failed.
  - **`search_history` survives and was deliberately not swept** — it is the
    RPC seam (D109 §1), and `CR-076a` flips its raise rather than removing it.
    Its one-word widening from "commit history" to "captured history" is true
    before and after that flip.
- **`commit_coverage` is documented with the argument an agent can actually
  produce (`CR-079e` follow-up, after mcp's `CR-142`).** The rules files said
  to pass `repository_id`, which was accurate against the server and still
  unusable: it is a uuid an agent has no route to — `blame_commit` does not
  return the id it resolves, so there was no path, direct or indirect. The
  line sat one bullet below `blame_commit`, which correctly takes a slug.
  `CR-142` made the tool accept `repo`, the same slug, resolved the same way;
  the rules files now say so and the two read verbs match on the page.
  - The alternative spelling is **deliberately not mentioned**. The server
    accepts either identifier but **exactly one** — supplying both is refused
    rather than resolved by precedence, because when they disagree there is no
    safe guess at intent. Naming an argument the reader cannot obtain would
    add only that hazard.
  - `ref` is called out as **required and not defaulted**, which is the
    server's own rule: a coverage number is ref-relative, so a guessed ref
    would put a wrong word in a true sentence.
- **The rules files teach the read lane's two verbs (`CR-079e`).**
  `blame_commit` and `commit_coverage` have shipped since `CR-085` and
  `docs/architecture.md` §3 names them as *the* read verbs of the MCP
  surface, but no rules file mentioned either — so every installed agent knew
  the read lane only through the tool that was about to be retired.
  `commit_coverage`'s description carries the server's own caveat: it returns
  the shas an edge is held for, never a percentage, because reachability from
  a ref is a local git question.
- **`README.md`** — the same two changes in the tool list under *How it
  works*, and the trailing deprecation parenthetical removed with them.
- **`bin/` re-vendored — the public bundle was shipping an older, less careful
  client (`CR-029e`).** It held **23** emitted `.js` against the client's **26**
  modules, and **15 of the 26 were absent or wrong**: three missing outright
  (`copy/time.js`, `install.js`, `redact.js`) and twelve differing in content.
  Now 26 files, 195,057 bytes, at the commit in `capture-bundle.json`.
  - **`redact.js` was not in the bundle at all**, and `hooks/entry.js` carried
    one incidental mention of the word against nine in the client. The
    out-of-tree redaction that keeps a **third party's file content** off the
    wire is a control the current client applies and the vendored one did not.
  - `index.js` still carried five inline user-facing literals the client had
    already moved into `copy/` — invisible to the claims gate for six waves,
    and still invisible in the copy a plugin user installs.
  - ⚠ **This pin goes stale again by design**: capture's `main` advances four
    more times this wave. That is the point — the gates above make the next
    drift a red check instead of an unmeasured fact.
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
    - **Resolved.** The three editable version fields are the *client's*
      (`package.json`, `src/version.ts`, the release tag) and `CR-029d` pinned
      them together in capture's own CI. The `X-Client-Version` header is the
      client's too — `bin/post.js` has sent it since the scaffold — so the
      plugin ships it by shipping the client. What was left on this side was
      the *bundle* skew, and that is `capture-bundle.json` plus the gates
      above. None of it turns on the plugin's own `version`, so it still does
      not move.

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
