#!/usr/bin/env node
/**
 * check_bundle.mjs — the vendored bundle's SELF-CONSISTENCY gate (CR-029e).
 *
 * `bin/` is committed, vendored output: the emitted JavaScript of the capture
 * client at one named commit (D57 §DX2 — `npx` on every `Stop` is a per-turn
 * cold-fetch tax, so the tree is shipped instead of resolved). Vendored content
 * rots silently. Before this gate existed, `bin/` was NINE capture commits
 * behind `main`, and nothing in this repo could have said so: the only workflow
 * here was `license-check.yml`, whose single step is `test -f LICENSE` (D85).
 *
 * WHAT THIS CHECKS, AND WHAT IT DELIBERATELY CANNOT
 *
 * Every gate below reads the checkout and NOTHING ELSE — no capture source
 * tree, no registry, no credential — which is exactly why it can run on every
 * pull request for free. It therefore proves the bundle is INTERNALLY
 * consistent and self-contained. It CANNOT prove the bundle matches the capture
 * client, because that needs the source, and this repo may not read it:
 * `vibecommit-capture` is private (D64) and this repo is public and MIT (D20),
 * so a cross-org read credential in this CI would invert the licensing boundary
 * the bundle exists inside. Corroboration against the published tarball is
 * `check_npm_bundle.mjs`; today it skips, loudly, and says why.
 *
 * ⚠ READ FILES WITH A REAL READER, NEVER A TEXT TOOL. The capture client's
 * `src/redact.ts` carries a literal NUL byte (a cache-key separator), so the
 * emitted `bin/redact.js` is classified as binary and `grep -I` SKIPS IT
 * SILENTLY — reporting clean on a file it never opened. That false negative is
 * recorded in capture's own `ci.yml` (CR-030d) and it is why every comparison
 * here goes through `readFileSync`.
 *
 * Usage:
 *   node scripts/check_bundle.mjs
 *   node scripts/check_bundle.mjs --update-pin --capture-commit <sha> \
 *                                 [--capture-version <v>]
 *
 * Exit codes: 0 consistent / 1 a gate failed / 2 bad usage.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN_FILE = "capture-bundle.json";
const PIN_PATH = join(ROOT, PIN_FILE);

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    console.error(`usage: ${name} needs a value`);
    process.exit(2);
  }
  return v;
};
const updatePin = argv.includes("--update-pin");
const newCommit = flag("--capture-commit");
const newVersion = flag("--capture-version");
if (updatePin && !newCommit) {
  console.error("usage: --update-pin requires --capture-commit <sha>");
  process.exit(2);
}

// ------------------------------------------------------------------ helpers

const failures = [];
const fail = (gate, ...lines) => failures.push({ gate, lines });

/** Every file under `dir`, as paths relative to it, POSIX-separated, sorted. */
function walk(dir) {
  const out = [];
  const recurse = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) recurse(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  recurse(dir);
  return out.sort();
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * The bundle's identity as one value. Digesting the sorted `<hash>  <path>`
 * manifest — not the concatenated bytes — means a RENAME changes the digest
 * too, which a content-only hash would miss.
 */
function measureBundle(binDir) {
  const files = walk(binDir);
  const perFile = {};
  let bytes = 0;
  for (const rel of files) {
    const buf = readFileSync(join(binDir, rel));
    perFile[rel] = sha256(buf);
    bytes += buf.length;
  }
  const manifest = files.map((f) => `${perFile[f]}  ${f}\n`).join("");
  return { files, perFile, bytes, digest: sha256(manifest) };
}

// -------------------------------------------------------------------- setup

const BIN_DIR = join(ROOT, "bin");
let binStat;
try {
  binStat = statSync(BIN_DIR);
} catch {
  console.error(`FATAL: no bin/ at ${BIN_DIR} — nothing to check.`);
  process.exit(1);
}
if (!binStat.isDirectory()) {
  console.error(`FATAL: ${BIN_DIR} is not a directory.`);
  process.exit(1);
}

let pin;
try {
  pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
} catch (err) {
  if (!updatePin) {
    console.error(`FATAL: cannot read ${PIN_FILE} — ${err.message}`);
    console.error("The pin is the single record of which capture commit bin/ was built from.");
    process.exit(1);
  }
  pin = { capture: {}, bundle: {} };
}

const allFiles = walk(BIN_DIR);
const measured = measureBundle(BIN_DIR);

// ------------------------------------------------ G1: nothing but .js in bin/

const nonJs = allFiles.filter((f) => !f.endsWith(".js"));
if (nonJs.length > 0) {
  fail(
    "only-js",
    "bin/ holds files that are not emitted JavaScript:",
    ...nonJs.map((f) => `    bin/${f}`),
    "bin/ is vendored output. Source maps, declarations and stray files do not belong in it.",
  );
}

// ------------------------------------------------------ G2: the entry exists

if (!allFiles.includes("index.js")) {
  fail("entry-present", "bin/index.js is missing — the hooks invoke it by path.");
}

// --------------------------------------------------------- G3: import closure
//
// Every specifier resolves to a `node:` builtin or to a file INSIDE bin/. This
// is D1a stated as something a machine can check: the bundle cannot reach
// outside itself at run time, so it cannot pull in code this MIT package does
// not ship. Containment is asserted explicitly — a relative specifier that
// escapes the tree (`../../something.js`) can exist on disk and still be a
// violation, so `isFile` alone is not the test.

const SPEC_RE = /\bfrom\s*"([^"]+)"|\bimport\s*\(\s*"([^"]+)"\s*\)/g;
const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
const present = new Set(jsFiles);
for (const rel of jsFiles) {
  const text = readFileSync(join(BIN_DIR, rel), "utf8");
  for (const m of text.matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith("node:")) continue;
    if (!spec.startsWith(".")) {
      fail(
        "import-closure",
        `bare (external) import ${JSON.stringify(spec)} in bin/${rel}`,
        "    the bundle is not self-contained: nothing outside bin/ is shipped with it.",
      );
      continue;
    }
    const target = join(dirname(rel), spec).split(sep).join("/");
    if (target.startsWith("..")) {
      fail(
        "import-closure",
        `escaping import ${JSON.stringify(spec)} in bin/${rel} resolves OUTSIDE bin/ (${target})`,
      );
      continue;
    }
    if (!present.has(target)) {
      fail(
        "import-closure",
        `unresolved import ${JSON.stringify(spec)} in bin/${rel} — bin/${target} does not exist`,
      );
    }
  }
}

// ------------------------------------------------------- G4: the entry runs
//
// A tree that lists correctly can still die on module resolution, which is the
// whole reason the bundle ships as a tree rather than a single file. So run it.
//
// ⚠ HARD TIMEOUT, AND A THROWAWAY HOME. A hook that blocks does not fail — it
// hangs, and a synchronous block cannot be interrupted by the client's own
// watchdog timer. That exact shape (an unwritable HOME blocking `mkdirSync`
// forever on Linux) hung capture's `main` for ~35 minutes behind five green
// macOS runs (D90). A writable temp HOME keeps this hermetic, and the timeout
// makes a hang a RED CHECK rather than a stalled runner.

if (allFiles.includes("index.js")) {
  const smokeHome = mkdtempSync(join(tmpdir(), "vc-bundle-smoke-"));
  const env = { ...process.env, HOME: smokeHome };
  // Drop any local VibeCommit configuration so a developer's real credential
  // and endpoint cannot influence — or be reached by — the smoke run.
  for (const k of Object.keys(env)) if (k.startsWith("VIBECOMMIT")) delete env[k];

  const payload = JSON.stringify({
    session_id: "bundle-check",
    transcript_path: "/nonexistent.jsonl",
    cwd: "/tmp",
    hook_event_name: "Stop",
  });
  const run = spawnSync(process.execPath, [join(BIN_DIR, "index.js"), "hook"], {
    input: payload,
    env,
    timeout: 15_000,
    encoding: "utf8",
  });

  if (run.error && run.error.code === "ETIMEDOUT") {
    fail(
      "entry-runs",
      "bin/index.js HUNG on a `hook` invocation (15s timeout).",
      "    A hook that blocks cannot be rescued by the client's own watchdog (D90).",
    );
  } else if (run.error) {
    fail("entry-runs", `bin/index.js could not be spawned — ${run.error.message}`);
  } else if (run.status !== 0) {
    fail(
      "entry-runs",
      `bin/index.js hook exited ${run.status} — the hook contract is exit 0 on every path.`,
      ...(run.stderr ? [`    stderr: ${run.stderr.trim().split("\n")[0]}`] : []),
    );
  }
}

// ------------------------------------------- G5: the tree matches the pin
//
// This is one half of the drift gate, and the half that needs no history: any
// edit to bin/ that leaves the pin alone lands here, NAMED. The other half —
// a pin that moves while bin/ stands still — is invisible to a single snapshot
// and is `check_bundle_pin.mjs`, which compares against the merge base.

if (updatePin) {
  pin.capture = {
    repo: "Vibe-Commit/vibecommit-capture",
    commit: newCommit,
    npmPackage: pin.capture?.npmPackage ?? "@vibe-commit/capture",
    npmVersion: newVersion ?? pin.capture?.npmVersion ?? null,
  };
  pin.bundle = {
    root: "bin",
    algorithm: "sha256",
    digest: measured.digest,
    fileCount: measured.files.length,
    byteCount: measured.bytes,
    files: measured.perFile,
  };
  writeFileSync(PIN_PATH, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`==> rewrote ${PIN_FILE} at ${newCommit}`);
}

const pinned = pin.bundle ?? {};
const pinnedFiles = pinned.files ?? {};
const added = measured.files.filter((f) => !(f in pinnedFiles));
const removed = Object.keys(pinnedFiles).filter((f) => !measured.perFile[f]);
const changed = measured.files.filter((f) => f in pinnedFiles && pinnedFiles[f] !== measured.perFile[f]);

if (added.length || removed.length || changed.length || pinned.digest !== measured.digest) {
  fail(
    "pin-matches-tree",
    `bin/ does not match ${PIN_FILE}.`,
    ...added.map((f) => `    added   bin/${f}`),
    ...removed.map((f) => `    removed bin/${f}`),
    ...changed.map((f) => `    changed bin/${f}`),
    `    pinned digest   ${pinned.digest ?? "(none)"}`,
    `    measured digest ${measured.digest}`,
    `    pinned ${pinned.fileCount ?? "?"} files / ${pinned.byteCount ?? "?"} bytes;` +
      ` measured ${measured.files.length} files / ${measured.bytes} bytes`,
    "",
    "    bin/ is vendored output, not editable source. Re-vendor it:",
    "        scripts/vendor_capture_bin.sh          # rewrites bin/ AND the pin",
  );
}

// ------------------------------------ G6: the capture commit lives in ONE place
//
// The pin is a fact about this repo, and a fact with two homes drifts. It had
// two: a shell default in `vendor_capture_bin.sh` and a paste in `CHANGELOG.md`
// prose. Both now derive from this file, and this gate is what keeps it that
// way — a future changelog entry that re-pastes the live sha fails here.
//
// Only the CURRENTLY pinned commit is constrained. A superseded sha in a
// released changelog entry is history, not a second copy of a live fact.

const commit = pin.capture?.commit;
if (!commit || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  fail("pin-well-formed", `${PIN_FILE} capture.commit is not a 40-character sha: ${commit}`);
} else {
  const tracked = spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" });
  if (tracked.status !== 0) {
    fail("single-source", `could not list tracked files: ${tracked.stderr?.trim()}`);
  } else {
    const short = commit.slice(0, 7);
    const offenders = [];
    for (const f of tracked.stdout.split("\n").filter(Boolean)) {
      if (f === PIN_FILE || f.startsWith("bin/")) continue;
      let text;
      try {
        text = readFileSync(join(ROOT, f), "utf8");
      } catch {
        continue; // deleted in the working tree; not our problem here
      }
      text.split("\n").forEach((line, i) => {
        if (line.includes(short)) offenders.push(`    ${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
    if (offenders.length > 0) {
      fail(
        "single-source",
        `the pinned capture commit (${short}) is recorded outside ${PIN_FILE}:`,
        ...offenders,
        `    ${PIN_FILE} is the one place this fact lives; everything else must derive from it.`,
      );
    }
  }
}

// ------------------------------------------------------------------- report

console.log(`bundle    : bin/ — ${measured.files.length} files, ${measured.bytes} bytes`);
console.log(`digest    : ${measured.digest}`);
console.log(`pinned to : ${pin.capture?.repo ?? "?"} @ ${commit ?? "?"}`);

if (failures.length > 0) {
  console.error("");
  console.error("check:bundle FAILED");
  for (const { gate, lines } of failures) {
    console.error(`  [${gate}] ${lines[0]}`);
    for (const l of lines.slice(1)) console.error(`  ${l}`);
  }
  process.exit(1);
}

console.log("check:bundle ok — self-consistent, import-closed, and matching the pin");
