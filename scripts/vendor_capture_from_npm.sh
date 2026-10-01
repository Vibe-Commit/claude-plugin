#!/usr/bin/env bash
# vendor_capture_from_npm.sh — rewrite bin/ from a PUBLISHED capture release (CR-225).
#
# The source-free twin of vendor_capture_bin.sh, and the reason capture-release.yml
# can open the re-vendor pull request itself instead of filing an issue about it.
#
# WHY THIS NEEDS NO CAPTURE SOURCE. vendor_capture_bin.sh rebuilds from the private
# repo, which this repo's CI may never read (D64 / D20). But `@vibe-commit/capture`
# publishes `--access public`, and its tarball's `package/dist/` IS the emitted tree
# capture's own CI built at the tag. check_npm_bundle.mjs already treats that tarball
# as the corroboration baseline; this script uses the same baseline as the SOURCE.
# Nothing closed is read, and no credential is needed.
#
# ⭐ MEASURED EQUIVALENCE, NOT ASSUMED. At 0.2.3, bin/ was produced by
# vendor_capture_bin.sh from source — and check_npm_bundle.mjs reports it
# byte-identical (50 files) to the 0.2.3 tarball, whose registry `gitHead` is the
# commit that source build was pinned to. Run from the 0.2.2 tree, this script
# reproduces that re-vendor commit's bin/ AND capture-bundle.json exactly.
# (No sha here on purpose: check_bundle.mjs's single-source gate fails the build
# if the live pin's commit appears in any tracked file but the pin.)
#
# WHERE THE PIN'S COMMIT COMES FROM. The registry's `gitHead` for that version —
# written by `npm publish` from the tag checkout. It is read, never typed, and it
# must be a 40-character sha or nothing is vendored.
#
# ⛔ WHAT THIS DOES NOT PROVE, AND vendor_capture_bin.sh STILL DOES: that the
# tarball is what a fresh build of the source at gitHead emits. That needs the
# source, so it stays a hand-run check where the source is legitimately in reach.
#
# Usage:
#   scripts/vendor_capture_from_npm.sh --version 0.2.4
#   VC_NPM_PACKAGE=<pkg> scripts/vendor_capture_from_npm.sh --version <v>
#
# Exit codes: 0 vendored and corroborated / 1 verification failed (bin/ may be
# rewritten — do not commit it) / 2 could not run (bad usage, registry, no gitHead).

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$PLUGIN_ROOT/bin"
PIN_FILE="$PLUGIN_ROOT/capture-bundle.json"

VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    *) echo "usage: $0 --version <x.y.z>" >&2; exit 2 ;;
  esac
done
if ! printf '%s' "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "error: --version must be a release version, got '${VERSION}'" >&2
  exit 2
fi

PKG="${VC_NPM_PACKAGE:-$(node -p "require('$PIN_FILE').capture.npmPackage")}"
SPEC="$PKG@$VERSION"

echo "==> reading $SPEC's gitHead from the registry"
GIT_HEAD="$(npm view "$SPEC" gitHead 2>/dev/null || true)"
if ! printf '%s' "$GIT_HEAD" | grep -Eq '^[0-9a-f]{40}$'; then
  # An empty answer here is "the registry did not say", never "there is nothing to
  # pin" — a bundle with no commit behind it is exactly what the pin exists to stop.
  echo "error: $SPEC has no 40-character gitHead in the registry (got '${GIT_HEAD}')" >&2
  exit 2
fi
echo "    gitHead $GIT_HEAD"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> npm pack $SPEC"
if ! npm pack "$SPEC" --pack-destination "$WORK" >/dev/null 2>"$WORK/pack.err"; then
  echo "error: npm pack $SPEC failed" >&2
  head -8 "$WORK/pack.err" >&2
  exit 2
fi
TGZ="$(find "$WORK" -maxdepth 1 -name '*.tgz' | head -1)"
[ -n "$TGZ" ] || { echo "error: npm pack produced no tarball" >&2; exit 2; }
tar -xzf "$TGZ" -C "$WORK"

PACKED_VERSION="$(node -p "require('$WORK/package/package.json').version")"
if [ "$PACKED_VERSION" != "$VERSION" ]; then
  echo "error: asked for $VERSION, the tarball says $PACKED_VERSION" >&2
  exit 2
fi
if [ ! -d "$WORK/package/dist" ]; then
  echo "error: $SPEC carries no package/dist/ — nothing to vendor" >&2
  exit 2
fi

# The same file selection as vendor_capture_bin.sh: emitted .js only. No maps, no
# declarations, no node_modules (the client has no runtime dependencies).
echo "==> vendoring package/dist/**/*.js -> bin/"
rm -rf "$BIN_DIR"
mkdir -p "$BIN_DIR"
( cd "$WORK/package/dist" && find . -name '*.js' -type f -print0 \
    | while IFS= read -r -d '' f; do
        mkdir -p "$BIN_DIR/$(dirname "$f")"
        cp "$f" "$BIN_DIR/$f"
      done )

echo "==> recording the pin"
node "$PLUGIN_ROOT/scripts/check_bundle.mjs" \
  --update-pin --capture-commit "$GIT_HEAD" --capture-version "$VERSION" >/dev/null

echo "==> verifying the vendored tree"
fail=0
node "$PLUGIN_ROOT/scripts/check_bundle.mjs" || fail=1

# ⛔ LOAD-BEARING, NOT A FORMALITY. This is what refuses a tarball the registry did
# not sign: check_npm_bundle.mjs exits 0 only on byte-identity AND a verified
# registry signature. Copying the bytes guarantees the first half; only this run
# establishes the second, so nothing here may be committed without it.
set +e
node "$PLUGIN_ROOT/scripts/check_npm_bundle.mjs" --version "$VERSION"
corroborated=$?
set -e
[ "$corroborated" -eq 0 ] || fail=1

[ "$fail" -eq 0 ] || exit 1

echo "==> OK"
echo "    version : $VERSION"
echo "    commit  : $GIT_HEAD (registry gitHead)"
echo "    files   : $(find "$BIN_DIR" -name '*.js' -type f | wc -l | tr -d ' ') .js"
