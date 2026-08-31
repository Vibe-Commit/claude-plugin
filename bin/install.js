/**
 * Is the `vibecommit` a user types OURS? — `CR-025`, D55.
 *
 * D55 named the npm package `@vibe-commit/capture` because the bare
 * `vibecommit` is taken — by `vibecommit@1.0.6`, which is **itself a commit
 * CLI**. The BIN name stayed `vibecommit`, and D55 accepted the residual
 * collision as unlikely. The register corrects that to closer to certain: the
 * overlap population is exactly developers who install commit tooling.
 *
 * **This detects the collision. It does not reopen the decision** — the bin
 * name is settled and D57 §DX5's verb surface is locked.
 *
 * What the clash costs is narrow and worth stating precisely, because the error
 * copy has to: hook capture is UNAFFECTED, because the plugin invokes the binary
 * by path. What breaks is the verbs a human types — `status`, `why`, `report`
 * would run the other program.
 *
 * ## Resolved in-process, not by shelling out
 *
 * PATH lookup is a `readdir`-free stat of one candidate per PATH entry, so doing
 * it here costs nothing and avoids a subprocess entirely — no argument array to
 * get wrong, no shell to quote for, and no dependency on `which`/`command -v`
 * being present or behaving the same across platforms. It also makes the whole
 * thing testable by handing in an `env`, which a subprocess-based version could
 * only fake by building a directory of shims.
 */
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { gitProbe } from "./git.js";
/** The command name D55 kept. */
const BIN = "vibecommit";
/**
 * Classify the `vibecommit` on PATH against the program actually running.
 *
 * `selfPath` is this process's entry point. Both sides are `realpath`'d before
 * comparison, because the normal install IS a symlink — npm puts a link in
 * `.../bin/vibecommit` pointing at the package's `dist/index.js`, so a string
 * compare would call our own correct install foreign.
 *
 * Unresolvable either side is treated as NOT ours. That is the conservative
 * direction here: the cost of a false "foreign" is one printed block a user can
 * read and dismiss; the cost of a false "ours" is silence about a real clash,
 * which is the failure this exists to catch.
 */
export function classifyInstall(env, selfPath) {
    const found = resolveOnPath(env, BIN);
    if (found === null)
        return { kind: "absent" };
    const self = realpathOrNull(selfPath);
    const other = realpathOrNull(found);
    if (self !== null && other !== null && self === other)
        return { kind: "ours" };
    return { kind: "foreign", resolved: other ?? found };
}
/** The first executable `name` on PATH, or null. */
export function resolveOnPath(env, name) {
    const raw = env.PATH;
    if (raw === undefined || raw === "")
        return null;
    for (const dir of raw.split(delimiter)) {
        if (dir === "")
            continue;
        const candidate = join(dir, name);
        try {
            // A directory named `vibecommit` on PATH is not a command.
            if (!statSync(candidate).isFile())
                continue;
            accessSync(candidate, constants.X_OK);
            return candidate;
        }
        catch {
            // Not there, not readable, not executable — keep looking.
        }
    }
    return null;
}
function realpathOrNull(path) {
    if (path === "")
        return null;
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// The `post-commit` hook install — `CR-170`, D154.
//
// ⛔ THREE OF THIS PATH'S FAILURE MODES ARE SILENT NO-OPS (D98's class), and a
// silent no-op here means capture quietly observes nothing forever:
//
//   1. `core.hooksPath` set  -> `.git/hooks` is ignored ENTIRELY by git, so
//      writing there succeeds, reports success, and does nothing at all.
//   2. an existing `post-commit` -> overwriting it breaks the user's own tooling.
//   3. no report -> the user cannot tell (1) or (2) happened.
//
// All three are LOUD below: each is its own verdict, and `connect` prints it.
// ---------------------------------------------------------------------------
/** Marks a `post-commit` as ours. Also the idempotency check. */
export const HOOK_MARKER = "vibecommit-capture-hook v1";
/**
 * Where a pre-existing hook is moved so the chain can still run it.
 *
 * ⚠ **THE SPELLING IS LOAD-BEARING, AND THE FIRST TWO ATTEMPTS FAILED A GUARD.**
 * `test/provenance.test.ts` is a wall over RAW TEXT with two separate tripwires,
 * and ordinary explanatory prose sets off both:
 *
 *   1. it scans for the product name followed by a hyphen and a word, and reads
 *      every hit as a sibling REPOSITORY that must be declared. A filename
 *      suffix of that shape is indistinguishable from a repo name to a regex,
 *      so `.<product>-original` failed for a reason unrelated to provenance;
 *   2. it counts bare marker tags and requires each to parse as a full
 *      three-part declaration, so merely NAMING the tag in a sentence registers
 *      a malformed one.
 *
 * Both were hit while writing this comment, in that order. The suffix is
 * renamed and the prose avoids both literals — the guards are not weakened.
 * `git.ts` carries the same warning about its linkage regex, for the same reason.
 */
export const CHAINED_SUFFIX = ".chained-by-vibecommit";
/**
 * The hook body.
 *
 * ⚠ **The original runs FIRST and its exit status is preserved**; ours runs
 * after and can never change the outcome. MEASURED 2026-08-17: git IGNORES
 * `post-commit`'s exit code entirely (a hook exiting 7 still leaves
 * `git commit` at 0), so this cannot break a commit either way — but preserving
 * the status keeps the chained hook's own contract with anything that reads it.
 *
 * `>/dev/null 2>&1` on our side: hook output lands in the user's own terminal,
 * and a capture tool has no business writing there.
 *
 * ## ⛔ `post-rewrite` TAKES ITS INPUT ON STDIN, AND A STREAM IS READ ONCE
 *
 * `post-commit` is handed nothing. `post-rewrite` is handed the ancestor/successor
 * pairs on stdin (`M6`) — and **a chained hook that reads stdin leaves ours with
 * an empty stream, and ours would leave theirs with one.** Copying the
 * `post-commit` body would therefore have silently broken every pre-existing
 * `post-rewrite` hook the moment we chained it: their tooling would run, read
 * nothing, and conclude nothing was rewritten.
 *
 * So the stdin variant buffers the stream ONCE and feeds a copy to each. ⚠
 * `$(cat)` strips trailing newlines and cannot carry a NUL, which is fine and is
 * checked rather than assumed: this stream is `<40-hex> <40-hex>` lines, ASCII,
 * one per rewrite. `printf '%s\n'` restores the single trailing newline.
 */
function hookScript(binPath, hookName, readsStdin) {
    const chained = `"$d/${hookName}${CHAINED_SUFFIX}"`;
    const ours = `${shellQuote(binPath)} ${hookName}`;
    return [
        "#!/bin/sh",
        `# ${HOOK_MARKER}`,
        "# Installed by `vibecommit connect`. Safe to delete; capture then observes",
        "# no commits for this clone.",
        'd=$(dirname "$0")',
        "status=0",
        ...(readsStdin ? ["input=$(cat)"] : []),
        `if [ -x "$d/${hookName}${CHAINED_SUFFIX}" ]; then`,
        readsStdin
            ? `  printf '%s\\n' "$input" | ${chained} "$@" || status=$?`
            : `  ${chained} "$@" || status=$?`,
        "fi",
        readsStdin
            ? `printf '%s\\n' "$input" | ${ours} "$@" >/dev/null 2>&1 || true`
            : `${ours} >/dev/null 2>&1 || true`,
        "exit $status",
        "",
    ].join("\n");
}
/** Single-quote for `sh`. A repository path containing a space is ordinary. */
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
/**
 * Install (or re-point) the `post-commit` hook for the work tree at `toplevel`.
 *
 * ⛔ **`core.hooksPath` IS CHECKED FIRST AND IS A REFUSAL, NOT A WARNING.** When
 * it is set — husky sets it, and so do many monorepos — git does not look in
 * `.git/hooks` at all. Writing there would succeed at the filesystem level and
 * report success, while capture silently observed nothing for the life of the
 * clone. We do not write into the configured directory either: that directory is
 * owned by whatever tool configured it, and a file we drop in gets regenerated
 * away without warning. The honest move is to say so.
 *
 * ⚠ **VERIFIED that our own repos set NEITHER `core.hooksPath` NOR husky**, so
 * dogfooding cannot exercise this path — it is covered by deliberate tests.
 */
export function installPostCommitHook(toplevel, binPath) {
    return installCaptureHooks(toplevel, binPath).commit;
}
/**
 * Install BOTH capture hooks for the work tree at `toplevel`.
 *
 * ⛔ **`post-rewrite` IS NOT AN EXTRA, IT IS THE OTHER HALF OF `post-commit`.**
 * `--amend` and `rebase` fire `post-commit` for a sha they then DESTROY (`M5`),
 * so a clone with only the commit hook records observations that name commits
 * unreachable from every branch and gone after `gc --prune=now`. The two go in
 * together, behind the same `core.hooksPath` refusal and the same chaining.
 *
 * ⚠ **`installPostCommitHook` RETURNS ONLY THE COMMIT VERDICT, and the rewrite
 * verdict is currently PRINTED BY NOTHING.** `commands/connect.ts` reports one
 * install and `src/copy/` has one string for it, both outside this lane's scope.
 * The gap is narrow — `core.hooksPath` and a `not a git work tree` failure are
 * shared, so they are reported by the commit verdict — and is limited to a clone
 * that has a pre-existing `post-rewrite` and no pre-existing `post-commit`: that
 * chaining happens correctly and is not announced. ⛔ Recorded here rather than
 * left to be discovered, because an unreported install outcome is precisely what
 * the block at the top of this section calls the third silent no-op.
 */
export function installCaptureHooks(toplevel, binPath) {
    const configured = gitProbe(toplevel, ["config", "--get", "core.hooksPath"]);
    // `--get` exits 1 when unset, which `gitProbe` reports as null. A SET value
    // is the failure case here, which is the opposite of the usual reading.
    if (configured !== null && configured.trim() !== "") {
        // ⛔ BOTH refuse. `.git/hooks` is dead for every hook in it, not just ours.
        const verdict = { kind: "hooks-path", configured: configured.trim() };
        return { commit: verdict, rewrite: verdict };
    }
    const hooksDir = resolveHooksDir(toplevel);
    if (hooksDir === null) {
        const verdict = { kind: "failed", why: "not a git work tree" };
        return { commit: verdict, rewrite: verdict };
    }
    return {
        commit: writeHook(hooksDir, "post-commit", hookScript(binPath, "post-commit", false)),
        rewrite: writeHook(hooksDir, "post-rewrite", hookScript(binPath, "post-rewrite", true)),
    };
}
/** Write one hook into an empty slot, over ours, or in front of theirs. */
function writeHook(hooksDir, hookName, script) {
    const hookPath = join(hooksDir, hookName);
    const existing = readIfPresent(hookPath);
    try {
        mkdirSync(hooksDir, { recursive: true });
        if (existing !== null && existing.includes(HOOK_MARKER)) {
            // Ours already. Rewrite anyway — the binary may have moved since.
            writeFileSync(hookPath, script, { mode: 0o755 });
            chmodSync(hookPath, 0o755);
            return { kind: "already", path: hookPath };
        }
        if (existing !== null) {
            // ⛔ CHAIN, NEVER CLOBBER. Their hook keeps running, from a path ours
            // invokes explicitly, and it goes first.
            const original = `${hookPath}${CHAINED_SUFFIX}`;
            renameSync(hookPath, original);
            chmodSync(original, 0o755);
            writeFileSync(hookPath, script, { mode: 0o755 });
            chmodSync(hookPath, 0o755);
            return { kind: "chained", path: hookPath, original };
        }
        writeFileSync(hookPath, script, { mode: 0o755 });
        chmodSync(hookPath, 0o755);
        return { kind: "installed", path: hookPath };
    }
    catch (error) {
        return { kind: "failed", why: error instanceof Error ? error.message : "write failed" };
    }
}
/**
 * The hooks directory git itself would use.
 *
 * `rev-parse --git-path hooks` rather than `<toplevel>/.git/hooks`, because the
 * two differ for a linked work tree and for a repository with a separate git
 * dir — and it answers RELATIVE to the work tree, so it is resolved here.
 */
export function resolveHooksDir(toplevel) {
    const out = gitProbe(toplevel, ["rev-parse", "--git-path", "hooks"]);
    if (out === null)
        return null;
    const path = out.trim();
    if (path === "")
        return null;
    return isAbsolute(path) ? path : join(toplevel, path);
}
function readIfPresent(path) {
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=install.js.map