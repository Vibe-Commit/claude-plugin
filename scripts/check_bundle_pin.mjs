#!/usr/bin/env node
/**
 * check_bundle_pin.mjs — bin/ and the pin move TOGETHER, or not at all (CR-029e).
 *
 * `check_bundle.mjs` proves the bundle matches the pin in a single snapshot.
 * That catches an edit to `bin/` that leaves `capture-bundle.json` alone — but
 * it is blind to the mirror-image mistake, because a pin whose `capture.commit`
 * moves while `bin/` stands still is still perfectly self-consistent. The two
 * halves of drift fail in OPPOSITE directions and only one of them is visible
 * without history, so this check reads the merge base.
 *
 * The rules, all three symmetric:
 *
 *   bin/ changed  &&  capture.commit did not   -> FAIL. bin/ is vendored
 *       output, not editable source. A hand-edit here is precisely how the
 *       bundle came to be nine capture commits behind `main` with nothing
 *       recording it.
 *   capture.commit changed  &&  bin/ did not   -> FAIL. The pin is a claim
 *       about the bytes. Moving it alone makes the claim false.
 *   bin/ changed  XOR  bundle.digest changed   -> FAIL. Belt and braces with
 *       `check_bundle.mjs`, and it names which half moved.
 *
 * Usage:  node scripts/check_bundle_pin.mjs [--base <ref>]     (default origin/main)
 * Exit codes: 0 coupled / 1 drift / 2 the comparison could not be made.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN_FILE = "capture-bundle.json";

const argv = process.argv.slice(2);
const baseIdx = argv.indexOf("--base");
const baseRef = baseIdx === -1 ? "origin/main" : argv[baseIdx + 1];
if (!baseRef) {
  console.error("usage: check_bundle_pin.mjs [--base <ref>]");
  process.exit(2);
}

const git = (...args) => spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8" });

// A ref this check cannot resolve must be an ERROR, never an empty diff. An
// empty result from a comparison that never ran is indistinguishable from a
// clean one, and reads as green.
const mergeBase = git("merge-base", baseRef, "HEAD");
if (mergeBase.status !== 0) {
  console.error(`check:bundle-pin — cannot find a merge base with ${baseRef}`);
  console.error(mergeBase.stderr?.trim());
  console.error("Fetch the base branch first; a missing base is not a passing check.");
  process.exit(2);
}
const base = mergeBase.stdout.trim();

const diff = git("diff", "--name-only", base, "HEAD");
if (diff.status !== 0) {
  console.error(`check:bundle-pin — git diff failed: ${diff.stderr?.trim()}`);
  process.exit(2);
}
const changedPaths = diff.stdout.split("\n").filter(Boolean);
const binChanged = changedPaths.filter((p) => p.startsWith("bin/"));

// The pin as it stood at the merge base. Absent means this branch introduces
// it — the bootstrap case, and the only one where the rules cannot apply.
const basePinRaw = git("show", `${base}:${PIN_FILE}`);
if (basePinRaw.status !== 0) {
  console.log(`check:bundle-pin — ${PIN_FILE} does not exist at ${base.slice(0, 7)}.`);
  console.log("This branch introduces the pin; there is no earlier value to compare against.");
  console.log(`check:bundle-pin ok (bootstrap) — ${binChanged.length} file(s) under bin/ changed`);
  process.exit(0);
}

let basePin;
let headPin;
try {
  basePin = JSON.parse(basePinRaw.stdout);
  headPin = JSON.parse(git("show", `HEAD:${PIN_FILE}`).stdout);
} catch (err) {
  console.error(`check:bundle-pin — ${PIN_FILE} is not valid JSON on one side: ${err.message}`);
  process.exit(2);
}

const commitChanged = basePin.capture?.commit !== headPin.capture?.commit;
const digestChanged = basePin.bundle?.digest !== headPin.bundle?.digest;

const failures = [];

if (binChanged.length > 0 && !commitChanged) {
  failures.push([
    `${binChanged.length} file(s) under bin/ changed, but capture.commit did not move.`,
    ...binChanged.slice(0, 10).map((p) => `    ${p}`),
    ...(binChanged.length > 10 ? [`    … and ${binChanged.length - 10} more`] : []),
    `    still pinned at ${headPin.capture?.commit}`,
    "    bin/ is emitted output. Re-vendor it from a named commit rather than editing it:",
    "        scripts/vendor_capture_bin.sh   # rewrites bin/ AND the pin, together",
  ]);
}

if (commitChanged && binChanged.length === 0) {
  failures.push([
    "capture.commit moved but not one byte of bin/ changed.",
    `    ${basePin.capture?.commit} -> ${headPin.capture?.commit}`,
    "    The pin is a claim about the bytes in bin/. Moving it alone makes that claim false —",
    "    the bundle still ships the older client while the repo says otherwise.",
    "        scripts/vendor_capture_bin.sh   # rebuild bin/ at the new commit",
  ]);
}

if ((binChanged.length > 0) !== digestChanged) {
  failures.push([
    binChanged.length > 0
      ? "bin/ changed but bundle.digest did not."
      : "bundle.digest changed but bin/ did not.",
    `    ${basePin.bundle?.digest} -> ${headPin.bundle?.digest}`,
    "    The digest is measured from bin/. Regenerate it rather than typing it:",
    "        node scripts/check_bundle.mjs --update-pin --capture-commit <sha>",
  ]);
}

console.log(`base      : ${base.slice(0, 7)} (${baseRef})`);
console.log(`bin/      : ${binChanged.length} file(s) changed`);
console.log(
  `pin       : commit ${commitChanged ? "MOVED" : "unchanged"}, digest ${digestChanged ? "MOVED" : "unchanged"}`,
);

if (failures.length > 0) {
  console.error("");
  console.error("check:bundle-pin FAILED");
  for (const lines of failures) {
    console.error(`  ${lines[0]}`);
    for (const l of lines.slice(1)) console.error(`  ${l}`);
  }
  process.exit(1);
}

console.log("check:bundle-pin ok — the bundle and its pin moved together");
