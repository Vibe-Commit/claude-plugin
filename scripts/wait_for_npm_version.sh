#!/usr/bin/env bash
# wait_for_npm_version.sh — wait, for a bounded window, until the registry shows a
# release that was JUST published (TODOS[150]).
#
# WHY THIS EXISTS. capture's `vendor-bundle` job dispatches the moment `npm publish`
# returns, and npm itself says the version "may take a few minutes to become
# available". On 0.3.0 the compare ran 61 s after the publish, `npm view` answered
# E404, and check_npm_bundle.mjs reported SKIPPED — "not published (D64)". The
# re-run two minutes later vendored it cleanly.
#
# ⛔ ONE ANSWER CANNOT TELL THE TWO APART. On npm 10.9.2 a version that is not yet
# visible and a package that was never published both answer `E404`, exit 1. Only
# TIME separates them: the dispatch fires after `publish` succeeded, so a 404 now
# means "not yet", and a 404 that outlives this window is the anomaly worth an issue.
# "Not yet" must never read as "never".
#
# `--prefer-online` on every probe: npm's local cache can keep answering with the
# listing it fetched before the publish (measured: `npm pack` said `notarget` for
# minutes while `npm view` already showed the version).
#
# Usage:
#   scripts/wait_for_npm_version.sh --version 0.3.0
#   VC_NPM_WAIT_SECS=20 VC_NPM_WAIT_INTERVAL=5 scripts/wait_for_npm_version.sh --version 9.9.9
#
# Exit codes: 0 the registry shows it / 3 still E404 when the window closed /
# 2 could not run (bad usage, or the last probe failed with something other than a 404).

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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
WINDOW="${VC_NPM_WAIT_SECS:-300}"
INTERVAL="${VC_NPM_WAIT_INTERVAL:-15}"

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

start=$SECONDS
attempt=0
while :; do
  attempt=$((attempt + 1))
  # `|| true`: a failed probe is data, not a reason to stop — set -e would end the
  # wait on the very first 404, which is the bug this script exists to fix.
  seen="$(npm view "$SPEC" version --prefer-online 2>"$ERR" || true)"
  waited=$((SECONDS - start))
  if [ "$seen" = "$VERSION" ]; then
    echo "registry shows $SPEC after ${waited}s (attempt $attempt)"
    exit 0
  fi
  if grep -Eqi 'E404|404 Not Found|is not in this registry' "$ERR"; then
    last="E404"
  else
    last="$(head -3 "$ERR" | tr '\n' ' ')"
    [ -n "$last" ] || last="answered '${seen}', not '${VERSION}'"
  fi
  echo "  ${waited}s: $SPEC not visible yet — $last"
  if [ "$waited" -ge "$WINDOW" ]; then
    break
  fi
  sleep "$INTERVAL"
done

if [ "$last" = "E404" ]; then
  echo "$SPEC was still E404 after ${waited}s (${attempt} probes). A release that is" \
    "published but not visible for this long is NOT the publish lag this wait absorbs."
  exit 3
fi
echo "error: could not confirm $SPEC after ${waited}s — the last probe failed: $last" >&2
exit 2
