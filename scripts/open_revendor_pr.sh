#!/usr/bin/env bash
# open_revendor_pr.sh — commit a re-vendored bin/ to a branch and open the PR (CR-225).
#
# Run by capture-release.yml AFTER vendor_capture_from_npm.sh has rewritten bin/ and
# the pin in the working tree and corroborated both. It turns that working tree into
# a pull request, which is the whole point: issues #20, #21 and #22 each quoted the
# exact remediation within ~16s of a release, and all three sat open through a night
# while two sessions re-derived their contents by hand. A signal with no consumer
# buys the belief in coverage (RUNBOOK §14).
#
# ⭐ IT NEVER LOSES THE SIGNAL. Every path writes `result=` to $GITHUB_OUTPUT and
# exits 0 unless the tree itself is wrong; the workflow files the old issue whenever
# `result` is not one of the three settled outcomes below.
#
#   opened   a new PR is open
#   exists   an open PR for this version's branch already exists — re-runs stop here
#   noop     the vendored tree equals the base; nothing to propose
#   pushed   the branch is pushed but the PR could NOT be opened (`detail=` says why)
#   failed   nothing was pushed (`detail=` says why)
#
# Env: RELEASE_VERSION (required), BASE_SHA (default HEAD), RUN_URL, GITHUB_REPOSITORY.
# Needs `gh` authenticated (GH_TOKEN) and a push-capable `origin`.

set -euo pipefail

: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
BASE_SHA="${BASE_SHA:-$(git rev-parse HEAD)}"
BRANCH="vendor/capture-v${RELEASE_VERSION}"
TITLE="Re-vendor bin/ from capture v${RELEASE_VERSION}"
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PLUGIN_ROOT"

out() {
  echo "$1=$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}
out branch "$BRANCH"

# ── already proposed? Checked FIRST, so a re-run or a duplicate dispatch for the same
# version is a no-op rather than a second PR.
if ! existing="$(gh pr list --head "$BRANCH" --state open --json url --jq '.[0].url // ""' 2>&1)"; then
  out result failed
  out detail "could not list pull requests: ${existing//$'\n'/ }"
  exit 0
fi
if [ -n "$existing" ]; then
  out result exists
  out url "$existing"
  exit 0
fi

# ── anything to propose? The vendor step rewrote bin/ in place; an unchanged tree
# means the bundle already was this release.
if [ -z "$(git status --porcelain -- bin capture-bundle.json)" ]; then
  out result noop
  exit 0
fi

# ⛔ ONLY bin/ AND ITS PIN. Anything else dirty means the vendor step touched a file
# it has no business touching, and a bot must not be the one to commit that.
stray="$(git status --porcelain | grep -vE '^.. (bin/|capture-bundle\.json$)' || true)"
if [ -n "$stray" ]; then
  out result failed
  out detail "the working tree has changes outside bin/ and capture-bundle.json: ${stray//$'\n'/ }"
  exit 1
fi

COMMIT="$(node -p "require('./capture-bundle.json').capture.commit")"

git checkout -q -B "$BRANCH"
git add -A -- bin capture-bundle.json
git -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit -q -m "$TITLE" -m "Vendored from the signed registry tarball of @vibe-commit/capture@${RELEASE_VERSION}; the pin records its registry gitHead. Opened by capture-release.yml (CR-225)."

# bundle.yml's pin-coupling job is a pull_request job, and GitHub does not trigger
# workflows from a PR that GITHUB_TOKEN opened — so it runs HERE, or not at all.
if ! node scripts/check_bundle_pin.mjs --base "$BASE_SHA"; then
  out result failed
  out detail "check_bundle_pin.mjs failed on the re-vendor commit"
  exit 1
fi

# ⚠ FORCE, AND ONLY ONTO THIS VERSION'S OWN BRANCH. It exists without an open PR only
# when an earlier run pushed it and could not open the PR; its content is a pure
# function of the version, so replacing it loses nothing.
if ! push_err="$(git push -q --force origin "HEAD:refs/heads/$BRANCH" 2>&1)"; then
  out result failed
  out detail "git push failed: ${push_err//$'\n'/ }"
  exit 0
fi

BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
{
  printf '%s\n' "\`vibecommit-capture\` published **${RELEASE_VERSION}**. This re-vendors \`bin/\` and"
  printf '%s\n' "\`capture-bundle.json\` together, so the plugin lane runs the same client as npm."
  printf '\n%s\n' "**Where the bytes came from.** The public, registry-signed tarball of"
  printf '%s\n' "\`@vibe-commit/capture@${RELEASE_VERSION}\` — \`package/dist/**/*.js\`, the tree capture's own CI"
  printf '%s\n' "built at the tag. No capture source was read (D64 / D20). The pin's commit is the"
  printf '%s\n' "registry's \`gitHead\` for that version: \`${COMMIT}\`."
  printf '\n%s\n' "**Gates that ran in the workflow run, all green:**"
  printf '%s\n' "- \`check:bundle\`: self-consistent, import-closed, matches the pin"
  printf '%s\n' "- \`check:npm-bundle\`: byte-identical to the tarball **and** a verified registry signature"
  printf '%s\n' "- \`check:bundle-pin\`: \`bin/\` and its pin moved together"
  printf '\n%s\n' "⚠ **\`bundle.yml\` will not start on its own for this PR.** GitHub does not trigger workflows"
  printf '%s\n' "from a pull request that \`GITHUB_TOKEN\` opened. Close and reopen it to run them under your"
  printf '%s\n' "own identity."
  printf '\n%s\n' "⚠ **Not proven here:** that the tarball is what a fresh build of the source at that commit"
  printf '%s\n' "emits. That needs the private source; from a checkout where it is in reach:"
  printf '\n%s\n' '```'
  printf '%s\n' "VC_COMMIT=${COMMIT} scripts/vendor_capture_bin.sh && git diff --exit-code bin capture-bundle.json"
  printf '%s\n' '```'
  if [ -n "${RUN_URL:-}" ]; then printf '\n%s\n' "[workflow run](${RUN_URL})"; fi
} > "$BODY"

# ⚠ THE STEP MOST LIKELY TO FAIL, AND ITS FAILURE IS A REPO SETTING, NOT A BUG.
# `GITHUB_TOKEN` may only open a PR when the repo allows it ("Allow GitHub Actions to
# create and approve pull requests"). When it cannot, the branch above is already
# pushed, so the fallback issue can hand a human a one-click compare link instead of
# a rebuild.
if url="$(gh pr create --base main --head "$BRANCH" --title "$TITLE" --body-file "$BODY" 2>&1)"; then
  out result opened
  out url "$(printf '%s' "$url" | tail -1)"
else
  out result pushed
  out detail "gh pr create failed: ${url//$'\n'/ }"
fi
