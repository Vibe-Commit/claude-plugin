#!/usr/bin/env bash
# verify_t7_parity.sh — CI-able parity check for M0-T14.
#
# Verifies that AGENTS.md, CLAUDE.md, and .claude/skills/vibecommit/SKILL.md
# in this repo byte-match the canonical content produced by T7's
# src/vendors/claude_code.ts + src/vendors/_shared/{agents_md,rules_body,managed_header}.ts.
#
# Strategy: run T7's TypeScript via Node (tsx/ts-node/node --input-type) to
# extract the actual string values. If Node/tsx is unavailable, fall back to
# a sed-based unescape of the template literal content. Either way, compare
# the canonical output against the plugin files.
#
# Usage:
#   # From the claude-plugin repo root:
#   T7_REPO=/path/to/vibecommit-mcp ./scripts/verify_t7_parity.sh
#
#   # With the default sibling-directory layout:
#   ./scripts/verify_t7_parity.sh
#
# Exit codes:
#   0 — all files match T7 source of truth
#   1 — one or more files differ (diff printed to stderr)
#
# T7 source of truth (read-only):
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
# Generate canonical content via Node/tsx (preferred) or via inline script
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
import { claudeCodeBundle } from "./src/vendors/claude_code.js";
const bundle = claudeCodeBundle();
for (const f of bundle.files) {
  const marker = `===FILE:${f.path}===`;
  process.stdout.write(marker + "\n");
  process.stdout.write(f.contents + "\n");
}
EXTRACTOR

  # Run from T7 repo so imports resolve
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
# Extract canonical content from Node output or inline
# ---------------------------------------------------------------------------

if [ "$EXTRACTION_MODE" = "node" ]; then
  # Parse the output file: split on ===FILE:<path>=== markers
  get_file_content() {
    local path="$1"
    awk -v marker="===FILE:${path}===" '
      $0 == marker { inside=1; next }
      inside && /^===FILE:/ { inside=0 }
      inside { print }
    ' "$TMPDIR_PARITY/output.txt" | head -c -1  # strip trailing newline added by print
  }

  CANONICAL_AGENTS_MD="$(get_file_content "AGENTS.md")"
  CANONICAL_CLAUDE_MD="$(get_file_content "CLAUDE.md")"
  CANONICAL_SKILL_MD="$(get_file_content ".claude/skills/vibecommit/SKILL.md")"

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
  CANONICAL_CLAUDE_MD="${MANAGED_HEADER}

${RULES_BODY}"

  # AGENTS.md = wrapManagedSection(MANAGED_HEADER_AGENTS_MD + "\n\n" + RULES_BODY)
  # wrapManagedSection strips leading/trailing newlines from body, then wraps:
  #   START + "\n" + trimmedBody + "\n" + END
  AGENTS_MD_BODY="${MANAGED_HEADER_AGENTS_MD}

${RULES_BODY}"
  # Strip leading blank lines, preserve internal structure, strip trailing newline
  AGENTS_MD_BODY_TRIMMED="$(printf '%s' "$AGENTS_MD_BODY" | awk 'NF{found=1} found')"

  CANONICAL_AGENTS_MD="${MANAGED_SECTION_START}
${AGENTS_MD_BODY_TRIMMED}
${MANAGED_SECTION_END}"

  # SKILL.md = frontmatter + "\n" + MANAGED_HEADER + "\n\n" + RULES_BODY
  SKILL_FRONTMATTER='---
name: vibecommit
description: Capture this session into VibeCommit by calling the commit_transcript MCP tool after each commit. Refresh instructions by calling the setup tool.
---'
  CANONICAL_SKILL_MD="${SKILL_FRONTMATTER}
${MANAGED_HEADER}

${RULES_BODY}"

fi

# ---------------------------------------------------------------------------
# Compare plugin files against canonical content
# ---------------------------------------------------------------------------

ERRORS=0

compare_file() {
  local label="$1"
  local plugin_file="$2"
  local canonical="$3"

  if [ ! -f "$plugin_file" ]; then
    echo "FAIL [$label]: file missing: $plugin_file" >&2
    ERRORS=$((ERRORS + 1))
    return
  fi

  # Read plugin file without trailing newline for comparison
  local plugin_content
  plugin_content="$(cat "$plugin_file")"

  if [ "$plugin_content" = "$canonical" ]; then
    echo "PASS [$label]: $plugin_file"
  else
    echo "FAIL [$label]: $plugin_file differs from T7 canonical content" >&2
    diff <(printf '%s\n' "$canonical") <(printf '%s\n' "$plugin_content") >&2 || true
    ERRORS=$((ERRORS + 1))
  fi
}

compare_file "CLAUDE.md" "$PLUGIN_ROOT/CLAUDE.md" "$CANONICAL_CLAUDE_MD"
compare_file "AGENTS.md" "$PLUGIN_ROOT/AGENTS.md" "$CANONICAL_AGENTS_MD"
compare_file "SKILL.md" "$PLUGIN_ROOT/.claude/skills/vibecommit/SKILL.md" "$CANONICAL_SKILL_MD"

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if [ "$ERRORS" -eq 0 ]; then
  echo ""
  echo "verify_t7_parity: ALL PASS — AGENTS.md + CLAUDE.md + SKILL.md byte-match T7 source of truth"
  exit 0
else
  echo "" >&2
  echo "verify_t7_parity: FAILED ($ERRORS file(s) differ from T7 source of truth)" >&2
  exit 1
fi
