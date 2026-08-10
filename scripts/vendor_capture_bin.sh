#!/usr/bin/env bash
# vendor_capture_bin.sh — rebuild bin/ from a named commit of the capture client.
#
# bin/ is COMMITTED, VENDORED content: the plugin ships the capture binary at
# ${CLAUDE_PLUGIN_ROOT}/bin so the Stop hook does not pay a cold `npx` fetch on
# every turn of every session (D57 §DX2). This script is what produced it, so
# anyone inspecting this public repo can reproduce the bundle byte-for-byte
# rather than taking the committed tree on trust (D64).
#
# WHAT GETS VENDORED, AND WHAT DELIBERATELY DOES NOT
#
#   yes  dist/**/*.js   the emitted runtime tree, byte-identical to what
#                       `npm run build` produces at $VC_COMMIT. The capture
#                       client declares NO runtime dependencies, so this tree
#                       is self-contained -- no node_modules is needed or shipped.
#   no   *.js.map       source maps. They point at src/ paths that do not exist
#                       here, and they roughly triple the bundle.
#   no   *.d.ts         type declarations. Nothing in a runtime bundle reads them.
#   no   node_modules/  see above -- there are no runtime dependencies to vendor.
#
# ⚠ LICENSING (D1a / D60 §D6). This bundle is MIT and PUBLIC. It may contain the
# capture client's own emitted output and NOTHING ELSE. The moment code from the
# closed vibecommit-mcp repo is lifted into the capture client, this script ships
# it inside an MIT package. `CR-030` is the CI gate for that; until it lands, the
# check at the end of this script is the only thing standing there.
#
# ⚠ THIS IS A MANUAL, ONE-SHOT VENDOR. CI automation, the X-Client-Version header
# and the client/plugin skew check are `CR-029e` and are deliberately NOT built
# here. The seam is left visible on purpose.
#
# Usage:
#   scripts/vendor_capture_bin.sh                      # default source + pinned commit
#   VC_REPO=/path/to/vibecommit-capture scripts/vendor_capture_bin.sh
#   VC_COMMIT=<sha> scripts/vendor_capture_bin.sh
#
# Exit codes: 0 vendored ok / 1 build or verification failed / 2 bad usage.

set -euo pipefail

# The commit bin/ was last vendored from. Bump this, re-run, and commit the diff.
VC_COMMIT="${VC_COMMIT:-8e772f181194e94a14fad412482f4a123acef135}"
VC_REPO="${VC_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/vibecommit-capture}"

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$PLUGIN_ROOT/bin"

if [ ! -d "$VC_REPO/.git" ]; then
  echo "error: no capture repo at $VC_REPO (set VC_REPO)" >&2
  exit 2
fi

# Build in a throwaway clone, never in $VC_REPO's working tree: that clone may
# belong to another builder, and `npm ci` + `tsc` would stomp their dist/.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> cloning $VC_REPO at $VC_COMMIT"
git clone -q --no-hardlinks "$VC_REPO" "$WORK/src"
git -C "$WORK/src" checkout -q "$VC_COMMIT"
git -C "$WORK/src" log --oneline -1

echo "==> npm ci && npm run build"
( cd "$WORK/src" && npm ci --silent && npm run build --silent )

echo "==> vendoring dist/**/*.js -> bin/"
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"
( cd "$WORK/src/dist" && find . -name '*.js' -type f -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "$BIN_DIR/$(dirname "$f")"
        cp "$f" "$BIN_DIR/$f"
      done )

echo "==> verifying the vendored tree"
fail=0

# Nothing but .js may be present.
if find "$BIN_DIR" -type f ! -name '*.js' | grep -q .; then
  echo "FAIL: non-.js files in bin/:" >&2
  find "$BIN_DIR" -type f ! -name '*.js' >&2
  fail=1
fi

# The entry must exist and must be the emitted CLI, shebang intact.
if [ ! -f "$BIN_DIR/index.js" ]; then
  echo "FAIL: bin/index.js missing" >&2
  fail=1
fi

# D1a, gate 1 of 2: the bundle must be EXACTLY the emitted tree at $VC_COMMIT --
# same file list, same bytes. This is what catches an extra module slipped into
# bin/ by hand, which a name-grep cannot see.
#
# ⚠ A `grep -rl 'vibecommit-mcp' bin/` is NOT this check and must not be mistaken
# for it. It fires on the capture client's own docblocks -- which name the closed
# repo precisely to record that its wire contract was RETYPED and that nothing was
# copied (D60 §D1a permits the former and forbids the latter). So it flags the
# compliance notes as violations, while a genuine lift that simply omitted the
# comment would pass it clean. It is a false positive and a false negative at once.
if ! diff -q \
     <(cd "$WORK/src/dist" && find . -name '*.js' -type f | sort | xargs shasum -a 256 | sed 's|  \./|  |') \
     <(cd "$BIN_DIR"       && find . -name '*.js' -type f | sort | xargs shasum -a 256 | sed 's|  \./|  |') \
     >/dev/null; then
  echo "FAIL: bin/ is not byte-identical to dist/ at $VC_COMMIT" >&2
  fail=1
fi

# D1a, gate 2 of 2: the bundle must be import-CLOSED. Every import resolves to a
# `node:` builtin or to a file that exists inside bin/. Nothing reaches outside
# this tree at runtime -- from the closed repo or from anywhere else. That is the
# property D1a actually cares about, stated as something a machine can check.
python3 - "$BIN_DIR" <<'PY' || fail=1
import os, re, sys
root = sys.argv[1]
spec_re = re.compile(r'\bfrom\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)')
bad = []
for dirpath, _, names in os.walk(root):
    for n in names:
        if not n.endswith(".js"):
            continue
        path = os.path.join(dirpath, n)
        rel = os.path.relpath(path, root)
        for m in spec_re.finditer(open(path, encoding="utf-8").read()):
            spec = m.group(1) or m.group(2)
            if spec.startswith("node:"):
                continue
            if not spec.startswith("."):
                bad.append(f"bare (external) import {spec!r} in {rel} -- bundle is not self-contained")
                continue
            target = os.path.normpath(os.path.join(dirpath, spec))
            if not os.path.isfile(target):
                bad.append(f"unresolved relative import {spec!r} in {rel}")
if bad:
    print("FAIL: " + "\nFAIL: ".join(bad), file=sys.stderr)
    sys.exit(1)
PY

# It must resolve its own imports. A dist/index.js copied without its siblings
# dies here with a module-resolution error -- which is the whole reason the tree
# is vendored rather than the single entry file.
if ! printf '%s' '{"session_id":"vendor-check","transcript_path":"/nonexistent.jsonl","cwd":"/tmp","hook_event_name":"Stop"}' \
     | node "$BIN_DIR/index.js" hook >/dev/null 2>&1; then
  echo "FAIL: vendored entry did not run cleanly (module resolution?)" >&2
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

echo "==> OK"
echo "    commit : $VC_COMMIT"
echo "    files  : $(find "$BIN_DIR" -name '*.js' -type f | wc -l | tr -d ' ') .js"
echo "    bytes  : $(find "$BIN_DIR" -name '*.js' -type f -exec cat {} + | wc -c | tr -d ' ')"
echo
echo "Record the commit above in CHANGELOG.md before committing bin/."
