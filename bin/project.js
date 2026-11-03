/**
 * What "this repository" means — ⛔ **TWO answers, and D184 splits them.**
 *
 * One value served four roles until `D184`. It still serves three of them; the
 * fourth — **the consent key** — moves, and `resolveProjectKeys` is where the two
 * surviving answers are produced together so a caller cannot take the wrong one
 * by accident:
 *
 * ```
 *  resolveProjectKeys(cwd) ──┬──> consent gate     = canonicalised git COMMON DIR   [MOVES]
 *                            ├──> session bucket   = worktree TOPLEVEL   (D58/CR-017d)
 *                            ├──> repoSlug input   = worktree TOPLEVEL
 *                            └──> redaction root   = NOT FROM HERE. A SET, and the
 *                                                    common dir is never in it (D184 §3).
 * ```
 *
 * ⛔ **The redaction confinement root is NOT one of the values this module
 * returns**, and that omission is the decision. `D184 §3`: if the confinement
 * root follows the consent key to the common dir, every file of an external
 * worktree is judged outside the main clone and `isInside` fail-closes each one
 * into a redaction marker. Capture succeeds, turn counts look right, the content
 * is gone. Widening it is `T2`'s work in `redact.ts`, against a root SET.
 *
 * ## ⛔ Why the consent key had to move at all
 *
 * Consent was keyed on `--show-toplevel`, which **differs per worktree**, with no
 * wildcards and absence-means-no. So an agent session inside a `git worktree`
 * captured **nothing** — no conversation, no commit, no notice — and `D19` makes
 * worktree-per-builder the house convention. `M2`: `rev-parse --git-path hooks`
 * in a linked worktree returns the MAIN clone's `.git/hooks`, so one install
 * already covers every worktree. The common dir is the identity the install
 * already had.
 *
 * ⚠ Deliberately NOT `src/git.ts`. `CR-019` owns that file (deriving the repo slug
 * for `X-Repo-Slug`) and would collide. This module holds only what the consent
 * gate needs; `CR-019` may fold it in when it lands.
 */
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { gitProbe } from "./git.js";
import { spawnTimeoutMs } from "./spawn_budget.js";
/** This spawn's own ceiling, used when no hook budget is armed. */
const TOPLEVEL_TIMEOUT_MS = 5_000;
/**
 * One `rev-parse` answer, or null.
 *
 * ⛔ **ONE ARGUMENT PER INVOCATION, and `resolveProjectKeys` therefore spawns
 * TWICE rather than once.** Prior learning `git-rev-parse-combined-args-fail-together`,
 * reproduced 10/10: *when the unresolvable arg is 40 hex, `rev-parse` exits 0 and
 * echoes it back verbatim as if it were an answer.* Reproduced again here on
 * 2026-08-21 — `rev-parse --show-toplevel <40×a>` prints the toplevel, then
 * `aaaa…`, and exits 0. A combined invocation therefore cannot be validated by
 * WHICH LINE the answer landed on, because a garbage answer occupies a line too.
 *
 * ⚠ **The cost is +1 spawn at hook entry, outside the 8-file loop**, and it is
 * accepted on the record (`D184 §6`). `hooks/post_commit.ts` arms no spawn
 * budget, deliberately, so this path is unaffected there.
 *
 * `execFileSync` with an argument array, never a shell string: a repository path
 * containing a space or a `;` is ordinary on a developer's machine and would be
 * a command-injection sink through `execSync`.
 */
function revParse(dir, arg) {
    const timeout = spawnTimeoutMs(TOPLEVEL_TIMEOUT_MS);
    if (timeout === null)
        return null;
    try {
        const out = execFileSync("git", ["-C", dir, "rev-parse", arg], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout,
        });
        const value = out.trim();
        return value === "" ? null : value;
    }
    catch {
        return null;
    }
}
/**
 * The git toplevel for `dir`, or null when it is not inside a work tree.
 *
 * ⚠ **The timeout DERIVES from the hook's remaining budget** (`TODOS[87]`).
 * `execFileSync` blocks the event loop, so the watchdog cannot fire while this
 * call is outstanding — a fixed 5s ceiling here is 5s the watchdog provably
 * cannot cover, and it is one of four such ceilings that summed to 20s against a
 * 5s budget. `null` means the budget is spent, and the answer is the one this
 * function already gives when git cannot tell us: no toplevel, so no consent,
 * so the hook does nothing. Silent by contract and correct by default.
 *
 * ⛔ **The answer is validated by CONTENT: `--show-toplevel` is absolute, always.**
 * Without that gate a `git` on `PATH` that echoed a 40-hex string back would have
 * it `resolve`d against `process.cwd()` and returned as a toplevel — accepted
 * because it arrived where an answer was expected. Fail closed instead.
 */
export function gitToplevel(dir) {
    const top = revParse(dir, "--show-toplevel");
    if (top === null || !isAbsolute(top))
        return null;
    return resolve(top);
}
/**
 * ⛔ **THE CONSENT KEY — the git common dir, canonicalised before it is ever a key.**
 *
 * ## `M3`: keying this naively is a SECURITY REGRESSION, not a formatting bug
 *
 * `--git-common-dir` is **`.git`, RELATIVE**, in a main clone, and an absolute
 * path in a linked worktree. Measured 2026-08-21, four shapes:
 *
 * | shape | `--git-common-dir` |
 * |---|---|
 * | main clone, `-C` the toplevel | `.git` |
 * | main clone, `-C` a subdirectory two deep | `../../.git` |
 * | linked worktree | `<main>/.git`, absolute |
 * | worktree of a BARE repo | `<repos>/project.git`, absolute |
 *
 * ⛔ Keyed on the raw string, **every main clone on the machine gets the key
 * `.git`** — consent to one repo would grant capture on all of them.
 *
 * ⛔ **And the base for that resolution is `dir`, NOT the toplevel.** Row 2 is
 * why, and it is the same hazard one layer over: `resolve(toplevel, "../../.git")`
 * for a repo at `…/scratch/repo` is `…/.git` — a key SHARED by every sibling repo
 * under that parent. Git's answer is relative to git's cwd, which `-C dir` makes
 * `dir`. `D184 §2` says "resolve against the toplevel"; measured, that is wrong
 * for the subdirectory case and this resolves against `dir`.
 *
 * ⚠ **`realpath` before it is a key**, so `/tmp/x` and `/private/tmp/x` are not
 * two grants for one repo, and so an unresolvable answer fails closed.
 *
 * ## The content check, which is what makes this not "trust the line"
 *
 * A 40-hex string is legal syntax for a RELATIVE common dir, so absoluteness
 * cannot reject it here the way it does for the toplevel. The answer must be a
 * directory that actually holds a `HEAD` — present in all four measured shapes
 * above, and absent from any directory that merely happens to exist under `dir`.
 * ⚠ Existence alone would be a check the fixture can satisfy by accident
 * (`project_redaction_fixture_must_exist_on_disk` is the same shape of trap).
 */
function gitConsentKey(dir) {
    const raw = revParse(dir, "--git-common-dir");
    if (raw === null)
        return null;
    let canonical;
    try {
        canonical = realpathSync(resolve(dir, raw));
    }
    catch {
        return null;
    }
    return existsSync(join(canonical, "HEAD")) ? canonical : null;
}
/**
 * Both keys for a directory, or **null** — ⛔ **fail closed, never a fallback.**
 *
 * If either spawn fails or either answer fails its content check, there is no
 * partial answer: a guessed consent key grants capture on a repository the user
 * never approved, and a guessed worktree key files a session under the wrong
 * repository permanently.
 *
 * ⚠ **NO MIGRATION PATH FOR EXISTING `projects.json` ENTRIES, deliberately.**
 * The allow list is keyed by string and the key changes shape, so a pre-existing
 * grant at a toplevel stops matching. Pre-launch there are zero users and zero
 * rows (`project_pre_launch_no_data`), so the migration is a no-op with nothing
 * to migrate — writing one would be speculative code guarding a case that cannot
 * occur. The observable cost if that assumption were ever wrong is one re-run of
 * `vibecommit connect`, not a silent grant.
 */
export function resolveProjectKeys(dir) {
    const worktree = gitToplevel(dir);
    if (worktree === null)
        return null;
    const consent = gitConsentKey(dir);
    if (consent === null)
        return null;
    return { worktree, consent };
}
/**
 * The worktree toplevel for a directory: the session bucket and slug input.
 *
 * ⛔ **NO LONGER THE CONSENT KEY — `D184` moved that to
 * `resolveProjectKeys(dir).consent`.** The name is kept because the three roles
 * it still serves are unchanged and every caller of it wants the toplevel; a
 * rename would be churn across files this change has no other reason to touch.
 *
 * Falls back to NOTHING. A directory outside a work tree has no project identity,
 * and inventing one from `cwd` would file a session under a key the user cannot
 * see in `vibecommit status`.
 */
export function resolveProjectKey(dir) {
    return gitToplevel(dir);
}
// ---------------------------------------------------------------------------
// Redaction roots (moved from `hooks/entry.ts` so `session_targets.ts` can use them without an import cycle).
// ---------------------------------------------------------------------------
/** The porcelain record's opening line — `worktree <absolute path>`. */
const WORKTREE_LINE = "worktree ";
/**
 * The MAIN work tree of the repository whose common dir this is, or **null**.
 *
 * ## ⛔ `rev-parse --show-toplevel` CANNOT ANSWER THIS, measured
 *
 * `D184 §4` mandates `git -C <common-dir> rev-parse --show-toplevel`. Measured
 * on git 2.39.5 against real repositories, that command exits **128** —
 * *"fatal: this operation must be run in a work tree"* — for **every shape a
 * consent key takes**, because a consent key is always a git DIRECTORY and
 * `--is-inside-work-tree` is `false` inside one:
 *
 * | `-C` | `--show-toplevel` |
 * |---|---|
 * | `<main>/.git` (main clone, and every worktree linked to it) | ⛔ ec 128 |
 * | `<repos>/project.git` (bare) | ⛔ ec 128 |
 *
 * Implemented literally, "a failure means no second root" would fire 100% of
 * the time: the set would be the singleton it is today, forever, and a
 * main-clone file read from a worktree session would come back a marker. The
 * whole change would pass its own tests while doing nothing.
 *
 * ## What answers instead, and why it is not a guess
 *
 * `git worktree list --porcelain` DOES run from a git dir and from a bare
 * directory, and its FIRST record is the main work tree. Bare repositories say
 * so in the record itself — `bare`, with no work tree of their own.
 *
 * ⛔ **The answer is then validated by CONTENT, never trusted by position:**
 * `realpath(<candidate>/.git)` must BE the consented common dir. That check is
 * independently fatal to every wrong answer this could produce — a bare repo
 * (`<repos>/.git` does not exist), a linked worktree returned first by some
 * future git (its `.git` is a FILE, so the realpath is the file, not the common
 * dir), a submodule work tree (same). `D184 §4`'s hazard is what it is for: in a
 * worktree of a bare repo the common dir is `…/repos/project.git`, whose parent
 * is **the folder holding every other repository on the machine**, and a root
 * derived by stripping a suffix would transmit every sibling repo's file
 * contents verbatim.
 *
 * Every failure yields NO SECOND ROOT. Never a fallback, never a parent, never a
 * suffix strip.
 */
export function mainWorkTree(commonDir) {
    const out = gitProbe(commonDir, ["worktree", "list", "--porcelain"]);
    if (out === null)
        return null;
    const record = [];
    for (const line of out.split("\n")) {
        if (line === "")
            break;
        record.push(line);
    }
    // A BARE repository HAS no work tree, and git says so in the record itself.
    if (record.includes("bare"))
        return null;
    const first = record[0];
    if (first === undefined || !first.startsWith(WORKTREE_LINE))
        return null;
    const candidate = first.slice(WORKTREE_LINE.length);
    if (!isAbsolute(candidate))
        return null;
    try {
        return realpathSync(join(candidate, ".git")) === commonDir ? candidate : null;
    }
    catch {
        return null;
    }
}
/**
 * ⛔ **The redaction confinement ROOT SET — `D184 §3`.**
 *
 * ```
 * isInsideAny([worktree, mainToplevel], candidate)
 * ```
 *
 * ## Why it is a set, and why the common dir is not in it
 *
 * `D184` moved the consent key to the git common dir so that a session inside a
 * `git worktree` is admitted at all. ⛔ **The confinement root MUST NOT follow
 * it there.** `isInside` realpaths both sides and fail-closes anything it cannot
 * place to *outside* — which here means REDACT — so a root at `<main>/.git`
 * would judge every file of an external worktree to be outside the main clone
 * and replace its `content`, `oldString`, `newString` and `structuredPatch` with
 * markers. **The capture still succeeds. The turn counts still look right. The
 * content is gone**, and a test asserting *"worktree sessions capture now"*
 * passes on an empty payload.
 *
 * Two roots, because both are genuinely the user's own tree: the worktree the
 * session is running in, and the main clone it was cut from — a builder in a
 * worktree reads the main clone's files constantly.
 *
 * ## ⛔ The `paths.ts:487-489` prohibition, answered — `D184 §5`
 *
 * > *"`roots` comes from the REGISTRY. It must never be derived from input."*
 *
 * **That prohibition is about PROVENANCE, and both members have the right one.**
 * The named hazard is *anything on hook stdin* — attacker-supplied. Neither of
 * these is: `keys` can only be produced by `resolveProjectKeys`, which is git's
 * own answer about the directory the session runs in; `mainToplevel` is git's
 * answer about the repository **the consent gate already approved**, and it is
 * content-validated by `mainWorkTree` above. The worktree root has exactly the
 * same provenance and has been used this way since `CR-024d`.
 *
 * ⚠ **Provenance is the whole argument, so this code preserves it:** nothing
 * here is read from stdin, the derivation is validated by content, and a failure
 * yields no second root rather than a fallback. An empty set would refuse
 * everything (`paths.ts:491-492`), which is the correct direction — but this
 * function cannot return one, because `keys.worktree` is always a member.
 *
 * ⚠ The dedup is cosmetic. `isInsideAny` over a repeated root is a union with
 * itself; it is dropped so that a main-clone session reads as the single root it
 * has always had, and so a cell asserting "no second root" is asserting
 * something.
 */
export function confinementRoots(keys) {
    const main = mainWorkTree(keys.consent);
    return main === null || main === keys.worktree ? [keys.worktree] : [keys.worktree, main];
}
//# sourceMappingURL=project.js.map