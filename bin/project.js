/**
 * What "this repository" means to the consent gate.
 *
 * Consent is per PROJECT, and the project key has to be the git toplevel rather
 * than the working directory: `cwd` differs between `repo/` and `repo/src/`, so a
 * cwd key would ask for consent again from a subdirectory and — worse — would let
 * a hook fired from a subdirectory read a transcript the user consented to at a
 * different key.
 *
 * ⚠ Deliberately NOT `src/git.ts`. `CR-019` owns that file (deriving the repo slug
 * for `X-Repo-Slug`) and would collide. This module holds only what the consent
 * gate needs; `CR-019` may fold it in when it lands.
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { spawnTimeoutMs } from "./spawn_budget.js";
/** This spawn's own ceiling, used when no hook budget is armed. */
const TOPLEVEL_TIMEOUT_MS = 5_000;
/**
 * The git toplevel for `dir`, or null when it is not inside a work tree.
 *
 * `execFileSync` with an argument array, never a shell string: a repository path
 * containing a space or a `;` is ordinary on a developer's machine and would be
 * a command-injection sink through `execSync`.
 *
 * ⚠ **The timeout DERIVES from the hook's remaining budget** (`TODOS[87]`).
 * `execFileSync` blocks the event loop, so the watchdog cannot fire while this
 * call is outstanding — a fixed 5s ceiling here is 5s the watchdog provably
 * cannot cover, and it is one of four such ceilings that summed to 20s against a
 * 5s budget. `null` means the budget is spent, and the answer is the one this
 * function already gives when git cannot tell us: no toplevel, so no consent,
 * so the hook does nothing. Silent by contract and correct by default.
 */
export function gitToplevel(dir) {
    const timeout = spawnTimeoutMs(TOPLEVEL_TIMEOUT_MS);
    if (timeout === null)
        return null;
    try {
        const out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout,
        });
        const top = out.trim();
        return top === "" ? null : resolve(top);
    }
    catch {
        return null;
    }
}
/**
 * The consent key for a directory: the git toplevel when there is one.
 *
 * Falls back to NOTHING. A directory outside a work tree has no project identity,
 * and inventing one from `cwd` would grant consent to a key the user cannot see
 * in `vibecommit status`.
 */
export function resolveProjectKey(dir) {
    return gitToplevel(dir);
}
//# sourceMappingURL=project.js.map