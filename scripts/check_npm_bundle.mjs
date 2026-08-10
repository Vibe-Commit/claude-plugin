#!/usr/bin/env node
/**
 * check_npm_bundle.mjs — corroborate bin/ against the PUBLISHED tarball (CR-029e).
 *
 * This is the right mechanism for proving the vendored bundle is the capture
 * client, and the only one this repo is allowed to have.
 *
 * WHY NOT JUST CLONE CAPTURE AND REBUILD. Because that is forbidden, not merely
 * awkward. `Vibe-Commit/vibecommit-capture` is private (D64) and
 * `Vibe-Commit/claude-plugin` is public non-negotiably (D20 — `/plugin
 * marketplace add` pulls the catalog from a public git remote). Minting a
 * cross-org PAT would hand a public MIT repo's CI a read credential for the
 * closed core, inverting the exact boundary the bundle's gates exist to
 * protect. Capture's own `ci.yml` refuses the same trade for the same reason,
 * and the argument is stronger here because this is the public side.
 *
 * WHY THE TARBALL IS FINE. `@vibe-commit/capture` publishes `--access public`,
 * so the tarball needs no credential at all — nothing closed is read, and the
 * registry signature (`npm audit signatures`) is the integrity baseline D64
 * named when it dropped `--provenance` for private-source builds.
 *
 * ⚠ AND IT CANNOT RUN TODAY. The package has NEVER been published: D64 says
 * plainly "do not publish to npm: the scope is unclaimed and the package is a
 * stub", and `npm view @vibe-commit/capture version` returns a 404. So this
 * check SKIPS — and the whole design of the skip is that it is LOUD, names its
 * reason, and is distinguishable from a pass. A check that silently no-ops when
 * its subject is absent is the empty-result-reads-as-clean failure this project
 * has hit repeatedly; an absent package is a KNOWN state, a registry outage is
 * NOT, and the two exit differently below.
 *
 * Usage:
 *   node scripts/check_npm_bundle.mjs                       # pinned package + version
 *   node scripts/check_npm_bundle.mjs --version 0.2.0       # a specific release
 *   VC_NPM_PACKAGE=<pkg> VC_NPM_SUBDIR=package \
 *     node scripts/check_npm_bundle.mjs                     # exercise the compare path
 *
 * Exit codes:
 *   0  corroborated — the tarball's emitted tree is byte-identical to bin/
 *   1  MISMATCH — it is published and it does not match, or its signature failed
 *   2  the check could not be made (registry error, bad usage) — NOT a skip
 *   3  SKIPPED — that package@version is not published (D64). Loud, and truthful.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN_DIR = join(ROOT, "bin");
const PIN_FILE = "capture-bundle.json";

const EXIT_OK = 0;
const EXIT_MISMATCH = 1;
const EXIT_ERROR = 2;
const EXIT_SKIPPED = 3;

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const pin = JSON.parse(readFileSync(join(ROOT, PIN_FILE), "utf8"));
const pkg = arg("--package") ?? process.env.VC_NPM_PACKAGE ?? pin.capture?.npmPackage;
const version = arg("--version") ?? process.env.VC_NPM_VERSION ?? pin.capture?.npmVersion;
// Where the emitted tree lives inside the tarball. Only ever overridden to
// point the compare path at some other public package for a red/green proof.
const subdir = process.env.VC_NPM_SUBDIR ?? "package/dist";

if (!pkg || !version) {
  console.error(`check:npm-bundle — ${PIN_FILE} has no npmPackage/npmVersion and none was given`);
  process.exit(EXIT_ERROR);
}
const spec = `${pkg}@${version}`;

/** Stdout, and the CI job summary when there is one. Property: CI STATES this. */
const say = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
};

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function walkJs(dir) {
  const out = [];
  const recurse = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) recurse(p);
      else if (e.name.endsWith(".js")) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  recurse(dir);
  return out.sort();
}

const digestTree = (dir) =>
  Object.fromEntries(walkJs(dir).map((rel) => [rel, sha256(readFileSync(join(dir, rel)))]));

// ------------------------------------------------- is it published at all?
//
// The one distinction that matters: E404 means "not published", which is a
// known, declared state (D64). Anything else — a network failure, a registry
// outage, an auth wall — means the check DID NOT RUN, and that must not wear
// the same face as a skip.

const view = spawnSync("npm", ["view", spec, "dist.tarball"], { encoding: "utf8" });
if (view.status !== 0) {
  const err = `${view.stdout ?? ""}${view.stderr ?? ""}`;
  const notPublished = /E404|404 Not Found|is not in this registry/i.test(err);
  if (!notPublished) {
    console.error("check:npm-bundle — COULD NOT REACH THE REGISTRY. This is not a skip.");
    console.error(err.trim().split("\n").slice(0, 8).join("\n"));
    process.exit(EXIT_ERROR);
  }

  say("### Bundle corroboration: **SKIPPED**");
  say("");
  say(`- pinned capture commit: \`${pin.capture?.commit ?? "?"}\``);
  say(`- would compare against: \`${spec}\``);
  say(`- **why it skipped**: \`${pkg}\` is **not published to npm**. D64 says plainly *"do not`);
  say('  publish to npm: the scope is unclaimed and the package is a stub"*, so there is no');
  say("  tarball to compare against — and this repo may not read the private source to build");
  say("  one itself (D64 / D20).");
  say("- **what is therefore UNVERIFIED**: that `bin/` is the emitted output of the pinned");
  say("  capture commit. The self-consistency gates still hold; byte-identity against the");
  say("  client does not, and nothing in this repo can currently establish it.");
  say("- this check turns itself on the day the package is published — no edit required.");
  console.log("");
  console.log(`check:npm-bundle SKIPPED — ${spec} is not published (D64). Not verified, not failed.`);
  process.exit(EXIT_SKIPPED);
}

// ------------------------------------------------------ fetch and compare
//
// ⚠ `process.exit()` does not run `finally`, so the outcome is recorded and
// returned rather than exited from — otherwise every non-trivial path would
// leave a temp tree behind.

const work = mkdtempSync(join(tmpdir(), "vc-npm-bundle-"));
try {
  process.exitCode = compare();
} finally {
  rmSync(work, { recursive: true, force: true });
}

function compare() {
  const pack = spawnSync("npm", ["pack", spec, "--pack-destination", work], { encoding: "utf8" });
  if (pack.status !== 0) {
    console.error(`check:npm-bundle — npm pack ${spec} failed. This is not a skip.`);
    console.error(`${pack.stdout ?? ""}${pack.stderr ?? ""}`.trim().split("\n").slice(0, 8).join("\n"));
    return EXIT_ERROR;
  }
  const tgz = readdirSync(work).find((f) => f.endsWith(".tgz"));
  if (!tgz) {
    console.error("check:npm-bundle — npm pack produced no tarball. This is not a skip.");
    return EXIT_ERROR;
  }
  const untar = spawnSync("tar", ["-xzf", join(work, tgz), "-C", work], { encoding: "utf8" });
  if (untar.status !== 0) {
    console.error(`check:npm-bundle — could not extract ${tgz}: ${untar.stderr?.trim()}`);
    return EXIT_ERROR;
  }

  let published;
  try {
    published = digestTree(join(work, subdir));
  } catch (err) {
    console.error(`check:npm-bundle — the tarball has no ${subdir}/: ${err.message}`);
    console.error("The published package does not carry an emitted tree where one was expected.");
    return EXIT_ERROR;
  }

  const vendored = digestTree(BIN_DIR);
  const added = Object.keys(published).filter((f) => !(f in vendored));
  const removed = Object.keys(vendored).filter((f) => !(f in published));
  const changed = Object.keys(published).filter((f) => f in vendored && published[f] !== vendored[f]);

  // The registry signature — the integrity baseline D64 kept when it dropped
  // `--provenance` for private-source builds. A tarball that matches bin/ but
  // is not the registry's own is not corroboration.
  const sig = verifySignature(spec, work);

  if (added.length || removed.length || changed.length || !sig.ok) {
    say("### Bundle corroboration: **MISMATCH**");
    say("");
    say(`- pinned capture commit: \`${pin.capture?.commit ?? "?"}\``);
    say(`- compared against: \`${spec}\` (${Object.keys(published).length} emitted \`.js\`)`);
    say(`- \`bin/\` holds ${Object.keys(vendored).length} \`.js\``);
    for (const f of added) say(`  - in the release, missing from \`bin/\`: \`${f}\``);
    for (const f of removed) say(`  - in \`bin/\`, absent from the release: \`${f}\``);
    for (const f of changed) say(`  - differs: \`${f}\``);
    say(`  - registry signature: ${sig.ok ? sig.detail : `**${sig.detail}**`}`);
    console.error("");
    console.error(`check:npm-bundle MISMATCH — bin/ is not ${spec}`);
    return EXIT_MISMATCH;
  }

  say("### Bundle corroboration: **verified**");
  say("");
  say(`- pinned capture commit: \`${pin.capture?.commit ?? "?"}\``);
  say(`- \`bin/\` is byte-identical to \`${spec}\` (${Object.keys(published).length} files)`);
  say(`- registry signature: ${sig.detail}`);
  console.log("");
  console.log(`check:npm-bundle ok — bin/ matches ${spec}`);
  return EXIT_OK;
}

/**
 * `npm audit signatures` needs a real install to audit, so give it a throwaway
 * project rather than running it against this repo (which has no package.json
 * and should not grow one for a check).
 */
function verifySignature(target, dir) {
  const proj = mkdtempSync(join(dir, "sig-"));
  const opts = { cwd: proj, encoding: "utf8" };
  const init = spawnSync("npm", ["init", "-y"], opts);
  if (init.status !== 0) return { ok: false, detail: "could not scaffold the audit project" };
  const install = spawnSync(
    "npm",
    ["install", target, "--ignore-scripts", "--no-audit", "--no-fund"],
    opts,
  );
  if (install.status !== 0) {
    return { ok: false, detail: `npm install ${target} failed inside the audit project` };
  }
  const audit = spawnSync("npm", ["audit", "signatures"], opts);
  const out = `${audit.stdout ?? ""}${audit.stderr ?? ""}`.trim();
  if (audit.status !== 0) {
    return { ok: false, detail: `npm audit signatures failed — ${out.split("\n")[0]}` };
  }
  const line = out.split("\n").find((l) => /verified/i.test(l)) ?? out.split("\n")[0] ?? "verified";
  return { ok: true, detail: line.trim() };
}
