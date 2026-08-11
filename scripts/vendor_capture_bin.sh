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
# ⚠ RUNNING THIS IS STILL MANUAL — it needs the capture source, which this repo
# may not read (D64/D20) — but the DRIFT IS NO LONGER INVISIBLE. `CR-029e` made
# the pin data (`capture-bundle.json`), moved the source-free gates into
# `scripts/check_bundle.mjs` so CI runs them on every PR, and added
# `scripts/check_bundle_pin.mjs` so bin/ and its pin cannot move apart. What
# stays here is the one gate that genuinely needs the source: byte-identity.
# (The `X-Client-Version` half of CR-029 is the client's own — `bin/post.js`
# sends it — so there is nothing for the plugin to add.)
#
# Usage:
#   scripts/vendor_capture_bin.sh                      # default source + pinned commit
#   VC_REPO=/path/to/vibecommit-capture scripts/vendor_capture_bin.sh
#   VC_COMMIT=<sha> scripts/vendor_capture_bin.sh
#
# Exit codes: 0 vendored ok / 1 build or verification failed / 2 bad usage.

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$PLUGIN_ROOT/bin"
PIN_FILE="$PLUGIN_ROOT/capture-bundle.json"

# The commit bin/ was vendored from is DATA, and this reads it rather than
# repeating it. It used to be a shell default here and a paste in CHANGELOG.md
# prose -- two editable copies of one fact, which is how the bundle came to sit
# nine capture commits behind `main` with nothing in the repo able to say so.
# `check_bundle.mjs` fails if a second copy of the live sha reappears anywhere.
VC_COMMIT="${VC_COMMIT:-$(node -p "require('$PIN_FILE').capture.commit")}"
VC_REPO="${VC_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/vibecommit-capture}"

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

echo "==> recording the pin"
# Written from the tree that was just produced, never typed. The digest and the
# per-file hashes in capture-bundle.json are what let CI catch a hand-edit of
# bin/ with no source tree in reach.
VC_VERSION="$(node -p "require('$WORK/src/package.json').version")"
node "$PLUGIN_ROOT/scripts/check_bundle.mjs" \
  --update-pin --capture-commit "$VC_COMMIT" --capture-version "$VC_VERSION" >/dev/null

echo "==> verifying the vendored tree"
fail=0

# Everything that needs no source tree lives in check_bundle.mjs, because CI has
# no source tree and must be able to run them on every PR: nothing but .js in
# bin/, the entry present, the import closure, the entry actually running, and
# the tree agreeing with the pin just written above.
if ! node "$PLUGIN_ROOT/scripts/check_bundle.mjs"; then
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

# D1a, gate 2 of 2 -- the import closure: every specifier resolves to a `node:`
# builtin or to a file INSIDE bin/, so nothing reaches outside this tree at run
# time, from the closed repo or anywhere else. That is the property D1a actually
# cares about, stated as something a machine can check. It moved into
# `check_bundle.mjs` (run above) because unlike byte-identity it needs no source
# tree, which is what lets CI run it on every pull request rather than only when
# somebody remembers to run this script.

[ "$fail" -eq 0 ] || exit 1

echo "==> OK"
echo "    commit : $VC_COMMIT"
echo "    files  : $(find "$BIN_DIR" -name '*.js' -type f | wc -l | tr -d ' ') .js"
echo "    bytes  : $(find "$BIN_DIR" -name '*.js' -type f -exec cat {} + | wc -c | tr -d ' ')"
echo
echo "capture-bundle.json now records that commit. Commit it TOGETHER with bin/:"
echo "check_bundle_pin.mjs fails a pull request that moves one without the other."
