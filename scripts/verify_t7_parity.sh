#!/usr/bin/env bash
# verify_t7_parity.sh — CI-able parity check for M0-T14.
#
# Verifies that the MIRROR — the content rendered by vibecommit-mcp's (T7's)
# src/vendors/claude_code.ts + src/vendors/_shared/{agents_md,rules_body,managed_header}.ts
# — byte-matches the CANONICAL rules text in this repo: AGENTS.md, CLAUDE.md,
# and .claude/skills/vibecommit/SKILL.md.
#
# ⛔ DIRECTION (D117 §2, D135 §4): THIS REPO IS CANONICAL. rules_body.ts IS THE
# MIRROR. Byte equality is symmetric, so the check itself has no direction —
# but its remediation does, and a diff cannot say which side is wrong. If the
# plugin text is right, make vibecommit-mcp's rules_body.ts match it. If the
# PLUGIN's text is what is wrong, fix it here first, merge, then mirror it.
# Never edit a plugin file just to match the mirror.
# (Until TODOS[156](b) this header named rules_body.ts the "source of truth",
# which is the direction D117 §2 ruled out.)
#
# Strategy: run T7's TypeScript via Node (tsx/ts-node/node --input-type) to
# extract the actual string values. If Node/tsx is unavailable, fall back to
# a sed-based unescape of the template literal content. Either way, compare
# the mirror's rendered output against the canonical plugin files.
#
# Usage:
#   # From the claude-plugin repo root:
#   T7_REPO=/path/to/vibecommit-mcp ./scripts/verify_t7_parity.sh
#
#   # With the default sibling-directory layout:
#   ./scripts/verify_t7_parity.sh
#
# Exit codes:
#   0 — the mirror matches all three canonical files
#   1 — one or more files differ (diff printed to stderr; the mirror follows the plugin)
#
# The MIRROR this checks (read-only here — fix it in vibecommit-mcp):
#   $T7_REPO/src/vendors/claude_code.ts
#   $T7_REPO/src/vendors/_shared/agents_md.ts
#   $T7_REPO/src/vendors/_shared/rules_body.ts
#   $T7_REPO/src/vendors/_shared/managed_header.ts
#   $T7_REPO/src/managed_section/sentinels.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Default: T7 repo is a sibling of the plugin repo
T7_REPO="${T7_REPO:-}"
if [ -z "$T7_REPO" ]; then
  CANDIDATE="$(cd "$PLUGIN_ROOT/../vibecommit-mcp" 2>/dev/null && pwd || true)"
  if [ -n "$CANDIDATE" ] && [ -d "$CANDIDATE" ]; then
    T7_REPO="$CANDIDATE"
  fi
fi

if [ -z "$T7_REPO" ] || [ ! -d "$T7_REPO" ]; then
  echo "ERROR: T7 repo not found. Set T7_REPO=/path/to/vibecommit-mcp" >&2
  echo "       or place vibecommit-mcp as a sibling of this repo." >&2
  exit 1
fi

# Verify T7 source files exist
for f in \
  "$T7_REPO/src/vendors/claude_code.ts" \
  "$T7_REPO/src/vendors/_shared/agents_md.ts" \
  "$T7_REPO/src/vendors/_shared/rules_body.ts" \
  "$T7_REPO/src/vendors/_shared/managed_header.ts" \
  "$T7_REPO/src/managed_section/sentinels.ts"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: T7 source file missing: $f" >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Render the mirror's content via Node/tsx (preferred) or via inline script
#
# We use Node to import T7's modules and serialize the exact runtime values.
# This is the only fully correct approach — the TypeScript source contains
# escaped backticks (\`) inside template literals, which must be unescaped at
# runtime to produce the actual string content.
# ---------------------------------------------------------------------------

# Try tsx (handles TypeScript imports natively)
NODE_RUNNER=""
if command -v tsx >/dev/null 2>&1; then
  NODE_RUNNER="tsx"
elif command -v npx >/dev/null 2>&1 && (cd "$T7_REPO" && npx tsx --version >/dev/null 2>&1); then
  NODE_RUNNER="npx tsx"
fi

TMPDIR_PARITY="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_PARITY"' EXIT

if [ -n "$NODE_RUNNER" ]; then
  # Write a small extractor script that imports T7 modules and prints the values
  cat > "$TMPDIR_PARITY/extract.ts" <<'EXTRACTOR'
import { claudeCodeBundle } from "__T7_REPO__/src/vendors/claude_code.ts";
const bundle = claudeCodeBundle();
for (const f of bundle.files) {
  const marker = `===FILE:${f.path}===`;
  process.stdout.write(marker + "\n");
  process.stdout.write(f.contents + "\n");
}
EXTRACTOR

  # Resolve the import to an absolute path so it works regardless of where the
  # extractor file lives (a relative ./src import breaks when run from a tempdir).
  sed -i.bak "s#__T7_REPO__#${T7_REPO}#" "$TMPDIR_PARITY/extract.ts" && rm -f "$TMPDIR_PARITY/extract.ts.bak"

  # Run from T7 repo so node_modules + tsconfig resolve
  if (cd "$T7_REPO" && $NODE_RUNNER "$TMPDIR_PARITY/extract.ts" > "$TMPDIR_PARITY/output.txt" 2>/dev/null); then
    EXTRACTION_MODE="node"
    echo "Extraction mode: tsx/node (runtime import of T7 modules)"
  else
    EXTRACTION_MODE="inline"
    echo "Extraction mode: inline (tsx unavailable or failed)" >&2
  fi
else
  EXTRACTION_MODE="inline"
  echo "Extraction mode: inline (tsx not found)" >&2
fi

# ---------------------------------------------------------------------------
# Extract the mirror's content from Node output or inline
# ---------------------------------------------------------------------------

if [ "$EXTRACTION_MODE" = "node" ]; then
  # Parse the output file: split on ===FILE:<path>=== markers
  get_file_content() {
    local path="$1"
    awk -v marker="===FILE:${path}===" '
      $0 == marker { inside=1; next }
      inside && /^===FILE:/ { inside=0 }
      inside { print }
    ' "$TMPDIR_PARITY/output.txt"  # trailing newline is stripped by the $(...) capture below
  }

  MIRROR_AGENTS_MD="$(get_file_content "AGENTS.md")"
  MIRROR_CLAUDE_MD="$(get_file_content "CLAUDE.md")"
  MIRROR_SKILL_MD="$(get_file_content ".claude/skills/vibecommit/SKILL.md")"

else
  # ---------------------------------------------------------------------------
  # Inline fallback: extract template literal content from TS source and
  # unescape \` → ` (the only escape that appears inside TS template literals
  # when the literal itself contains backticks — which none of these do, so
  # this fallback is safe for the current T7 content).
  #
  # We use sed to:
  #   1. Find the line matching `export const FOO = \``
  #   2. Strip the declaration prefix
  #   3. Collect lines until the closing `\`;`
  #   4. Output the interior
  # ---------------------------------------------------------------------------

  extract_ts_literal_safe() {
    local file="$1"
    local varname="$2"
    # State machine: print lines between opening and closing backtick.
    # Closing line: any line ending with "`;" (the closing backtick + semicolon
    # of the template literal, which may be preceded by content e.g. "-->`;").
    awk -v var="$varname" '
      !inside && $0 ~ "^export const " var " = `" {
        inside=1
        # Strip the declaration prefix up to and including the opening backtick
        line=$0
        sub("^export const " var " = `", "", line)
        # If the remainder itself ends with `; the literal is on one line
        if (line ~ /`;$/) {
          sub(/`;$/, "", line)
          print line
          inside=0
          next
        }
        print line
        next
      }
      inside {
        # Closing line: ends with backtick-semicolon
        if ($0 ~ /`;$/) {
          # Print everything before the closing `;
          line=$0
          sub(/`;$/, "", line)
          if (line != "") print line
          inside=0
          next
        }
        # Unescape \` → ` (for template literals that contain backticks)
        line=$0
        gsub(/\\`/, "`", line)
        print line
      }
    ' "$file"
  }

  RULES_BODY="$(extract_ts_literal_safe "$T7_REPO/src/vendors/_shared/rules_body.ts" "RULES_BODY")"
  MANAGED_HEADER="$(extract_ts_literal_safe "$T7_REPO/src/vendors/_shared/managed_header.ts" "MANAGED_HEADER")"
  MANAGED_HEADER_AGENTS_MD="$(extract_ts_literal_safe "$T7_REPO/src/vendors/_shared/managed_header.ts" "MANAGED_HEADER_AGENTS_MD")"

  MANAGED_SECTION_START="<!-- vibecommit:managed:start -->"
  MANAGED_SECTION_END="<!-- vibecommit:managed:end -->"

  # CLAUDE.md = MANAGED_HEADER + "\n\n" + RULES_BODY
  MIRROR_CLAUDE_MD="${MANAGED_HEADER}

${RULES_BODY}"

  # AGENTS.md = wrapManagedSection(MANAGED_HEADER_AGENTS_MD + "\n\n" + RULES_BODY)
  # wrapManagedSection strips leading/trailing newlines from body, then wraps:
  #   START + "\n" + trimmedBody + "\n" + END
  AGENTS_MD_BODY="${MANAGED_HEADER_AGENTS_MD}

${RULES_BODY}"
  # Strip leading blank lines, preserve internal structure, strip trailing newline
  AGENTS_MD_BODY_TRIMMED="$(printf '%s' "$AGENTS_MD_BODY" | awk 'NF{found=1} found')"

  MIRROR_AGENTS_MD="${MANAGED_SECTION_START}
${AGENTS_MD_BODY_TRIMMED}
${MANAGED_SECTION_END}"

  # SKILL.md = frontmatter + "\n" + MANAGED_HEADER + "\n\n" + RULES_BODY
  SKILL_FRONTMATTER='---
name: vibecommit
description: Capture this session into VibeCommit by calling the commit_conversation MCP tool after each meaningful chunk of work (and right after each commit). Refresh instructions by calling the setup tool.
---'
  MIRROR_SKILL_MD="${SKILL_FRONTMATTER}
${MANAGED_HEADER}

${RULES_BODY}"

fi

# ---------------------------------------------------------------------------
# Compare the mirror's rendered content against the canonical plugin files
# ---------------------------------------------------------------------------

ERRORS=0

compare_file() {
  local label="$1"
  local plugin_file="$2"
  local mirror="$3"

  if [ ! -f "$plugin_file" ]; then
    echo "FAIL [$label]: file missing: $plugin_file" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi

  # Read plugin file without trailing newline for comparison
  local plugin_content
  plugin_content="$(cat "$plugin_file")"

  if [ "$plugin_content" = "$mirror" ]; then
    echo "PASS [$label]: $plugin_file"
  else
    echo "FAIL [$label]: the mirror rendered from \$T7_REPO differs from canonical $plugin_file (D117 §2: the mirror follows this file)" >&2
    echo "  diff: '<' = mirror (rendered from \$T7_REPO), '>' = canonical ($plugin_file)" >&2
    diff <(printf '%s\n' "$mirror") <(printf '%s\n' "$plugin_content") >&2 || true
    ERRORS=$((ERRORS + 1))
  fi
}

compare_file "CLAUDE.md" "$PLUGIN_ROOT/CLAUDE.md" "$MIRROR_CLAUDE_MD"
compare_file "AGENTS.md" "$PLUGIN_ROOT/AGENTS.md" "$MIRROR_AGENTS_MD"
compare_file "SKILL.md" "$PLUGIN_ROOT/.claude/skills/vibecommit/SKILL.md" "$MIRROR_SKILL_MD"

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [ "$ERRORS" -eq 0 ]; then
  echo ""
  echo "verify_t7_parity: ALL PASS — the T7 mirror byte-matches canonical AGENTS.md + CLAUDE.md + SKILL.md"
  exit 0
else
  echo "" >&2
  echo "verify_t7_parity: FAILED ($ERRORS file(s): the T7 mirror differs from the canonical plugin text)" >&2
  echo "  The diff cannot say WHICH side is wrong. If the plugin text is right, change rules_body.ts to match it." >&2
  echo "  If the plugin text is what is wrong, fix it here first, merge, then mirror it — plugin first, always (D117 §2)." >&2
  exit 1
fi
