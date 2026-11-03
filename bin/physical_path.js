/**
 * C70: ONE resolver for every path judgement.
 *
 * JavaScript's `realpathSync` runs `path.resolve` FIRST, which collapses `..` lexically: `A/shared/../secret.env`, with `A/shared` a link to `/repos/B/pkg`, is judged
 * `A/secret.env`, while the kernel (and `realpathSync.native`) open `/repos/B/secret.env`. A call that runs in, or writes into, another repository through a link
 * and a `..` was judged as this one. `physicalPath` walks the RAW components forward with a physical cursor, as the kernel does: `.` and empty components are
 * skipped, `..` is the parent of the PHYSICAL cursor, and a component that is a link is replaced by its fully resolved target. Nothing is normalised before it.
 *
 * Fail closed: a component that exists but cannot be resolved (a dangling link, a loop, an unreadable folder) makes the whole path `null`.
 */
import { lstatSync, readlinkSync } from "node:fs";
import { dirname, isAbsolute, parse, sep } from "node:path";
/** More components than any path the OS accepts (PATH_MAX is 4096): a longer one is not resolved. */
const MAX_COMPONENTS = 4096;
/** The longest path, in bytes, that is resolved at all: at least the longest the kernel accepts (Linux 4,095 bytes, macOS 1,024), so nothing longer could have been opened. */
export const MAX_PATH_BYTES = 4096;
/** C74 (3): is this path (as a record wrote it) longer than any path the kernel could have opened? Such a path is unresolvable AT PLACEMENT: it is never stored. */
export function pathTooLong(path) {
    return Buffer.byteLength(path, "utf8") > MAX_PATH_BYTES;
}
/**
 * `base` + `relative`, the way the kernel reads them: a trailing separator is not doubled and `.` / empty components are dropped, but `..` is KEPT (it is only
 * meaningful after the links before it are resolved, which is `physicalPath`'s job).
 */
export function joinRaw(base, relative) {
    const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0)
        return base;
    return `${base.endsWith(sep) ? base : base + sep}${parts.join(sep)}`;
}
/** The kernel's own limit on links followed while resolving one path (MAXSYMLINKS is 32 on Linux, 40 elsewhere). */
const MAX_LINKS = 40;
/**
 * The walk behind `physicalPath`. The kernel's own: a component that is a link is replaced, in place, by the components of its target (a relative target is read from
 * the link's own physical parent, an absolute one from the root), so a `..` inside a target is also taken after the links before it. Only `lstat` and `readlink`
 * are used. A link whose target is missing is dangling: `null` (it exists, so it is never "continued past"); so is a loop, a path longer than MAX_PATH_BYTES, and a
 * component `lstat` cannot read (EACCES, ENAMETOOLONG, EIO): the hook cannot tell whether it is a link, so a `..` after it is the same case as a `..` after a link, and
 * when the physical answer cannot be known the rule fails closed (C49 (8)). C72 (1): Claude's `isInside` therefore equals 0.8.0 on every path with no `..` after a link
 * and no `..` after a component that cannot be read; on those paths it WITHHOLDS (over-withholding, never a leak).
 *
 * BELOW the last place that exists nothing can be a link and nothing needs a syscall: a missing component sets `depth` to 1, a name there is appended (depth + 1) and a
 * `..` there takes the parent (depth - 1), all lexically; once `depth` is back at 0 the walk looks at the file system again. So a path with thousands of missing
 * components costs no more than its existing part.
 */
export function physicalWalk(raw) {
    // C72 (2): a bound at least as large as the longest path the kernel accepts (Linux PATH_MAX counts the NUL, so 4,095 bytes; macOS 1,024): a longer path is refused with
    // ENAMETOOLONG before any lookup, so nothing could have been opened through it. Checked before any split, so one crafted line cannot cost more than 4,096 bytes of
    // walking (below a missing component the walk is a growing string). The absolute half rests on the agents handing the kernel the cwd-joined form (Codex joins first,
    // mirrored by codex_folders.ts `joinRaw`; Claude's paths are absolute): a tool that passed a long relative string itself would be over-withheld, never leaked.
    if (pathTooLong(raw))
        return null;
    const absolute = isAbsolute(raw) ? raw : joinRaw(process.cwd(), raw);
    if (pathTooLong(absolute))
        return null;
    const root = parse(absolute).root;
    const pending = [];
    const parts = absolute.slice(root.length).split(sep);
    if (parts.length > MAX_COMPONENTS)
        return null;
    for (let i = parts.length - 1; i >= 0; i -= 1)
        pending.push({ part: parts[i], viaLink: false });
    let current = root;
    let depth = 0;
    let links = 0;
    let steps = 0;
    for (let item = pending.pop(); item !== undefined; item = pending.pop()) {
        steps += 1;
        if (steps > 4 * MAX_COMPONENTS)
            return null;
        const { part, viaLink } = item;
        if (part === "" || part === ".")
            continue;
        if (part === "..") {
            current = dirname(current);
            if (depth > 0)
                depth -= 1;
            continue;
        }
        const next = current.endsWith(sep) ? current + part : current + sep + part;
        if (depth > 0) {
            current = next;
            depth += 1;
            continue;
        }
        let isLink;
        try {
            isLink = lstatSync(next).isSymbolicLink();
        }
        catch (error) {
            const code = error.code;
            if (code !== "ENOENT" && code !== "ENOTDIR")
                return null;
            // A component the target of a link names that is not there makes the link dangling: it exists, so it is never continued past.
            if (viaLink)
                return null;
            current = next;
            depth = 1;
            continue;
        }
        if (!isLink) {
            current = next;
            continue;
        }
        links += 1;
        if (links > MAX_LINKS)
            return null;
        let target;
        try {
            target = readlinkSync(next);
        }
        catch {
            return null;
        }
        if (target === "")
            return null;
        let rest = target;
        if (isAbsolute(target)) {
            const targetRoot = parse(target).root;
            current = targetRoot;
            rest = target.slice(targetRoot.length);
        }
        const targetParts = rest.split(sep);
        if (pending.length + targetParts.length > 4 * MAX_COMPONENTS)
            return null;
        for (let i = targetParts.length - 1; i >= 0; i -= 1)
            pending.push({ part: targetParts[i], viaLink: true });
    }
    return { path: current, depth };
}
/**
 * The physical place `raw` names. `missing`: `"extend"` (default) keeps a path whose last components are not there (a file that is to be created; the caller
 * works up to the nearest place that exists); `"fail"`: the whole path must exist (`null` otherwise, as `realpathSync` threw). `..` is taken in both after the links
 * before it. A relative `raw` is read from the working folder.
 */
export function physicalPath(raw, missing = "extend") {
    const walk = physicalWalk(raw);
    if (walk === null)
        return null;
    return missing === "fail" && walk.depth > 0 ? null : walk.path;
}
/** The nearest place that EXISTS at or above `raw`, physically; `null` for a dangling link or a loop, or when more than `maxMissing` components are missing. */
export function nearestExistingPhysical(raw, maxMissing = 64) {
    const walk = physicalWalk(raw);
    if (walk === null || walk.depth > maxMissing)
        return null;
    let current = walk.path;
    for (let i = 0; i < walk.depth; i += 1)
        current = dirname(current);
    return current;
}
//# sourceMappingURL=physical_path.js.map