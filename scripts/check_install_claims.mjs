#!/usr/bin/env node
// check_install_claims.mjs — TODOS[171] D9. The plugin's docs must not claim the plugin installs the rules files.
//
// Claude Code's plugin loader loads skills from `skills/` (or a `skills` key in plugin.json) and does NOT load a plugin-root
// CLAUDE.md or AGENTS.md as context. This repo has neither a `skills/` directory nor a `skills` key (its skill sits at
// `.claude/skills/vibecommit/SKILL.md`), so a plugin install gives an agent hooks and the MCP config — and no rules text.
// The rules files reach a project through the server's `setup` tool. A doc that says otherwise is false.
//
// Usage: node scripts/check_install_claims.mjs [root]   (exit 0 clean, 1 on a false claim or a failed self-check)
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const FILES = ["README.md", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
// Phrases that claim the plugin delivers/installs the rules files, or that an install makes the agent call setup/commit_conversation.
const FALSE_CLAIMS = [
  /delivers three rules files/i,
  /installs(?:(?!\. [A-Z])[^\n"])*?\brules files\b/i, // within ONE sentence (a ". " + capital ends it; dots inside file names do not)
  /Calls `setup` once per session/i,
  /Calls `commit_conversation` to capture your work/i,
];
const REQUIRED_IN_README = [/rules files are not installed by the plugin/i];

export function findFalseClaims(text) {
  return FALSE_CLAIMS.filter((re) => re.test(text)).map(String);
}

// SELF-CHECK (a check that can pass without running is not a check): the detector must FIRE on the pre-fix wording.
const PRE_FIX = [
  "The plugin delivers three rules files to your project and configures the MCP server",
  "installs deterministic hooks (Stop, PreCompact, SessionEnd), the AGENTS.md + CLAUDE.md + SKILL.md rules files, and MCP read tools",
  "- Calls `setup` once per session to load the capture rules",
  "- Calls `commit_conversation` to capture your work — after each meaningful chunk",
];
for (const s of PRE_FIX) {
  if (findFalseClaims(s).length === 0) {
    console.error(`SELF-CHECK FAILED: the detector did not fire on the known-false wording: ${s}`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(process.argv[2] ?? ".");
  let bad = 0;
  let examined = 0;
  for (const f of FILES) {
    const text = readFileSync(join(root, f), "utf8");
    examined++;
    for (const hit of findFalseClaims(text)) { console.error(`${f}: false install claim ${hit}`); bad++; }
  }
  const readme = readFileSync(join(root, "README.md"), "utf8");
  for (const re of REQUIRED_IN_README) if (!re.test(readme)) { console.error(`README.md: missing the required statement ${re}`); bad++; }
  if (examined !== FILES.length) { console.error("examined the wrong number of files"); process.exit(1); }
  console.log(`check_install_claims: ${examined} files examined, ${bad} problem(s)`);
  process.exit(bad === 0 ? 0 : 1);
}
