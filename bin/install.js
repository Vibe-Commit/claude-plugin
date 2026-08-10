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
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
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
//# sourceMappingURL=install.js.map