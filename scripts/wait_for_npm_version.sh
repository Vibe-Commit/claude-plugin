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
# ⛔ READY MEANS THE NEXT STEPS CAN RESOLVE IT, NOT THAT ONE QUERY ANSWERS. Two
# probes, because the steps after this one resolve the release two different ways.
# ⚠ Neither probe IS the install: (2) resolves and fetches but links no bin. That
# residue is why check_npm_bin_runs.mjs retries its own install on not-found —
# do not drop those retries on the strength of this wait.
#   1. `npm view <spec> version` — the full package document, which the compare
#      and the vendor script read (`dist.tarball`, `gitHead`).
#   2. `npm pack <spec> --dry-run` — the resolver `npm pack` and `npm install`
#      use, through to the tarball. It writes nothing. Measured: `npm pack` said
#      `notarget` for minutes while `npm view` already showed the version, so (1)
#      alone can hand a good release to an install that fails.
# A missing version answers E404 to (1) and ETARGET to (2); both mean "not yet".
#
# `--prefer-online` on every probe: npm's local cache can keep answering with the
# listing it fetched before the publish.
#
# ⛔ EVERY PROBE IS BOUNDED FROM OUTSIDE. `--fetch-timeout` does not cover the TCP
# connect: against an unroutable registry one `npm view` with
# `--fetch-retries=0 --fetch-timeout=10000` took 75 s (measured). So each probe
# runs under `timeout`, and the workflow step carries `timeout-minutes` too.
#
# Usage:
#   scripts/wait_for_npm_version.sh --version 0.3.0
#   VC_NPM_WAIT_SECS=20 VC_NPM_WAIT_INTERVAL=5 scripts/wait_for_npm_version.sh --version 9.9.9
#
# Exit codes: 0 both probes resolve it / 3 still not found when the window closed /
# 2 could not run (bad usage, or the last probe failed some other way, e.g. timed out).

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
PROBE_SECS="${VC_NPM_PROBE_SECS:-30}"
NPM_FLAGS=(--prefer-online --fetch-retries=0 --fetch-timeout=10000)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
ERR="$WORK/err"

# coreutils `timeout` is on every GitHub ubuntu runner. It is NOT in macOS base:
# it resolves only when Homebrew's coreutils is on PATH, so the same script is
# bounded for one person and not for the next (measured: absent on a stock PATH,
# where the script still runs). Without it a probe is bounded only by npm, which
# does not cover the TCP connect — so say so once instead of degrading silently.
# In CI the step's `timeout-minutes` remains either way.
if command -v timeout >/dev/null 2>&1; then
  HAVE_TIMEOUT=1
else
  HAVE_TIMEOUT=0
  echo "warning: no \`timeout\` on PATH — this script does not bound its probes; a dead registry holds each one until the OS connect timeout (~75 s on macOS)." >&2
fi
bounded() {
  if [ "$HAVE_TIMEOUT" -eq 1 ]; then
    timeout "$PROBE_SECS" "$@"
  else
    "$@"
  fi
}

# Sets `last` to NOTFOUND, TIMEOUT, or the first lines of the error.
classify() {
  local rc="$1"
  if [ "$rc" -eq 124 ]; then
    last="TIMEOUT (probe exceeded ${PROBE_SECS}s)"
  elif grep -Eqi 'E404|404 Not Found|is not in this registry|ETARGET|notarget|No matching version' "$ERR"; then
    last="NOTFOUND"
  else
    last="$(head -3 "$ERR" | tr '\n' ' ')"
    [ -n "$last" ] || last="exit $rc with no message"
  fi
}

start=$SECONDS
attempt=0
while :; do
  attempt=$((attempt + 1))
  # `|| rc=$?`: a failed probe is data, not a reason to stop — set -e would end the
  # wait on the very first 404, which is the bug this script exists to fix.
  rc=0
  seen="$(bounded npm view "$SPEC" version "${NPM_FLAGS[@]}" 2>"$ERR")" || rc=$?
  if [ "$rc" -eq 0 ] && [ "$seen" != "$VERSION" ]; then
    rc=1
    echo "answered '${seen}', not '${VERSION}'" >"$ERR"
  fi
  probe="view"
  if [ "$rc" -eq 0 ]; then
    probe="pack"
    bounded npm pack "$SPEC" --dry-run --pack-destination "$WORK" "${NPM_FLAGS[@]}" \
      >/dev/null 2>"$ERR" || rc=$?
  fi
  waited=$((SECONDS - start))
  if [ "$rc" -eq 0 ]; then
    echo "registry resolves $SPEC for view AND pack after ${waited}s (attempt $attempt)"
    exit 0
  fi
  classify "$rc"
  echo "  ${waited}s: $SPEC not ready yet ($probe) — $last"
  if [ "$waited" -ge "$WINDOW" ]; then
    break
  fi
  sleep "$INTERVAL"
done

if [ "$last" = "NOTFOUND" ]; then
  echo "$SPEC was still not found ($probe) after ${waited}s (${attempt} probes). A release" \
    "that is published but not resolvable for this long is NOT the publish lag this wait absorbs."
  exit 3
fi
echo "error: could not confirm $SPEC after ${waited}s — the last probe failed: $last" >&2
exit 2
