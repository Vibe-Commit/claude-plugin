#!/usr/bin/env node
/**
 * check_npm_bin_runs.mjs — install a published capture release the way a user
 * does, and EXECUTE the `vibecommit` command it links (TODOS[150]).
 *
 * WHY THE BYTES ARE NOT ENOUGH. check_npm_bundle.mjs proves bin/ is byte-identical
 * to the tarball, which is exactly as good as the tarball. 0.1.0, 0.2.0 and 0.2.1
 * shipped a `dist/index.js` (16,709 / 19,191 / 19,191 bytes — not empty) that is
 * fine when run as `node dist/index.js` and does NOTHING when run as `vibecommit`:
 * 0 bytes of output and exit 0 on every verb. Its main-module guard compared
 * `import.meta.url` (the RESOLVED file) TEXTUALLY against `process.argv[1]` (the
 * path as invoked), so any symlink on the way broke it: npm's bin link, a shim,
 * even a symlinked parent directory (macOS `/var` -> `/private/var`; VC, measured).
 * It never matched, and the process exited 0 with no output. Measured:
 *
 *   node <prefix>/lib/node_modules/@vibe-commit/capture/dist/index.js --version  ->  0.2.1
 *   <prefix>/bin/vibecommit --version                                             ->  (nothing), exit 0
 *
 * Every byte and symbol check passed on that release, and so would a re-vendor of
 * it — the plugin lane runs the file directly and never meets the symlink. The npm
 * lane is the only one that goes through it, so this runs it through it.
 *
 * ⛔ AN EXIT CODE IS NOT A PASS. The defect above exits 0. So the gate is the
 * OUTPUT: stdout must be exactly the version that was asked for — not "something
 * version-shaped", which a stale or mis-tagged build would also print.
 *
 * Usage:
 *   node scripts/check_npm_bin_runs.mjs --version 0.3.0     # green
 *   node scripts/check_npm_bin_runs.mjs --version 0.2.1     # the measured RED control
 *
 * Exit codes:
 *   0  installed, linked, and `vibecommit --version` printed exactly <version>
 *   1  installed, and the command is missing, failed, hung, or printed anything else
 *   2  the check could not be made (bad usage, registry, install failed) — NOT a pass
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PIN_FILE = "capture-bundle.json";
// The command a user is told to type. Asserted, not read from the tarball's own
// package.json: a release that renamed its bin would pass a check that asked it.
const COMMAND = "vibecommit";
const RUN_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;
// The wait step already confirmed `npm pack` resolves the release; these retries
// cover the residue of the publish lag, and ONLY a not-found answer is retried.
const INSTALL_RETRY_DELAYS_MS = [10_000, 20_000];
const NOT_FOUND = /E404|404 Not Found|is not in this registry|ETARGET|notarget|No matching version/i;

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_ERROR = 2;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const pin = JSON.parse(readFileSync(join(ROOT, PIN_FILE), "utf8"));
const pkg = arg("--package") ?? process.env.VC_NPM_PACKAGE ?? pin.capture?.npmPackage;
const version = arg("--version");

if (!pkg || !version || !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("usage: check_npm_bin_runs.mjs --version <x.y.z>  (package from capture-bundle.json)");
  process.exit(EXIT_ERROR);
}
// VC_NPM_SPEC installs something else (a local tarball) under the same checks.
// Only ever set for a red/green proof of this script — the same role as
// check_npm_bundle.mjs's VC_NPM_SUBDIR. The expected output is still --version.
const spec = process.env.VC_NPM_SPEC || `${pkg}@${version}`;

/** Stdout, and the CI job summary when there is one. */
const say = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  }
};

const clip = (s) => {
  const t = (s ?? "").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
};

// ⚠ `process.exit()` does not run `finally`, so the outcome is returned, not
// exited from — the same shape as check_npm_bundle.mjs.
const work = mkdtempSync(join(tmpdir(), "vc-npm-bin-"));
try {
  process.exitCode = check();
} finally {
  rmSync(work, { recursive: true, force: true });
}

function check() {
  const prefix = join(work, "prefix");
  // A throwaway HOME, and an ALLOWLISTED environment, for the program we are about
  // to run: this executes freshly downloaded code, and a defective build must not
  // be able to read the runner's credentials or touch its (or a developer's) real
  // config while it is being judged. The env is where credentials live, so it is
  // built from nothing rather than filtered from `process.env`.
  const home = join(work, "home");
  mkdirSync(home);

  // `-g --prefix` is what creates the bin SYMLINK — the one thing under test. A
  // local install into node_modules/.bin would test a different path.
  // `--ignore-scripts` still links bins; it only refuses install-time scripts.
  let install;
  for (let attempt = 0; ; attempt++) {
    install = spawnSync(
      "npm",
      ["install", "-g", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-online", spec],
      { encoding: "utf8", timeout: INSTALL_TIMEOUT_MS },
    );
    const said = `${install.stdout ?? ""}${install.stderr ?? ""}`;
    if (install.status === 0 || attempt >= INSTALL_RETRY_DELAYS_MS.length || !NOT_FOUND.test(said)) break;
    const ms = INSTALL_RETRY_DELAYS_MS[attempt];
    console.log(`check:npm-bin — ${spec} not resolvable yet; retrying the install in ${ms / 1000}s`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
  if (install.status !== 0) {
    const why = install.error ? `${install.error.code ?? install.error.message}` : clip(`${install.stdout ?? ""}${install.stderr ?? ""}`);
    console.error(`check:npm-bin — npm install ${spec} failed. This is not a pass.`);
    console.error(why);
    return EXIT_ERROR;
  }

  const bin = join(prefix, "bin", COMMAND);
  let linked = false;
  try {
    linked = lstatSync(bin).isSymbolicLink();
  } catch {
    linked = false;
  }
  if (!linked) {
    return fail(`installed, but npm linked no \`${COMMAND}\` symlink at ${bin}`);
  }

  // Executed as a user's shell executes it: the symlink itself, through its
  // shebang — never `node <resolved path>`, which is the path that hid 0.2.1.
  const run = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: RUN_TIMEOUT_MS,
    // PATH only so the shebang's `/usr/bin/env node` finds node.
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  });
  if (run.error) {
    return fail(`\`${COMMAND} --version\` could not be run: ${run.error.code ?? run.error.message}`);
  }
  const out = (run.stdout ?? "").trim();
  if (run.status !== 0 || out !== version) {
    return fail(
      `\`${COMMAND} --version\` exited ${run.status} and printed [${clip(run.stdout)}]` +
        (clip(run.stderr) ? `, stderr [${clip(run.stderr)}]` : "") +
        ` — expected exactly [${version}]`,
    );
  }

  say("### Published command: **runs**");
  say("");
  say(`- \`npm install -g ${spec}\` linked \`${COMMAND}\`, and \`${COMMAND} --version\` printed \`${out}\``);
  console.log("");
  console.log(`check:npm-bin ok — ${spec} runs through its bin symlink`);
  return EXIT_OK;
}

function fail(detail) {
  say("### Published command: **DOES NOT RUN**");
  say("");
  say(`- installed \`${spec}\` the way a user does (\`npm install -g\`)`);
  say(`- ${detail}`);
  say("- every byte check can pass on such a release; re-vendoring it would ship the same defect");
  console.error("");
  console.error(`check:npm-bin FAILED — ${spec}: ${detail}`);
  return EXIT_FAILED;
}
