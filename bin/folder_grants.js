/**
 * Folder grants — the consent half of any-folder capture (R3 · R6, A-T5).
 *
 * ⛔ **FOLDER GRANTS ARE LIVE, with no client switch.** D9's rule (the server makes a folder repository private to its uploader
 * BEFORE any client sends a folder stream) is held by the RELEASE ORDER (schema, mcp, web, then capture: D20 · B, one wave), not
 * by a flag here: a constant that is always true is a second code path with nothing behind it. Against a server that lacks the
 * rule the upload fails (`later`) and the bytes are held, so nothing is stored readable.
 *
 * A folder grant lives in its OWN file, `folders.json`, keyed by the folder's REAL path, not in `projects.json`: that file is
 * keyed by git common dir and enumerated as CLONES by `status` and `machine_state`, in this build and in 0.8.0 (measured: a
 * `folder:` key there makes 0.8.0's `status` say "Capture is on for 2 repos"). A separate file is invisible to every older
 * reader. Client-side only: never synced, because the server holds no path and never refuses a `local:` slug. CLI-only writes,
 * like every consent write: a hook never writes this file. An entry is `granted` or `excluded` (D11: undecided means neither): the
 * picker's No and `-N` record `excluded`, which `status` and the resolver treat like a denied repo, and which the picker offers
 * again so it can be turned back on. A module of its own, so `consent.ts` keeps its two atomic writes
 * (`updateGrants`' pinned property).
 */
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic_write.js";
import { foldersPath, rootDir } from "./paths.js";
/**
 * Folder entries by REAL path. Every failure is an empty map: absence is a NO, exactly like `projects.json`.
 *
 * ⛔ **ONLY THE EXACT VALUES `"granted"` AND `"excluded"` ARE A DECISION** (fail closed). An entry whose state is absent, unknown,
 * misspelt or not a string is NOT a grant: it is dropped here, so the folder stands `undecided` everywhere (the resolver, `status`,
 * the picker), neither captured nor recorded as turned off. An earlier reading took everything but `"excluded"` as granted, which
 * made a hand-edited, truncated or newer-client entry a consent nobody gave.
 */
export function readFolderGrants(home) {
    let raw;
    try {
        raw = readFileSync(foldersPath(home), "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const { at, state } = value;
                if (state !== "granted" && state !== "excluded")
                    continue;
                out[key] = { at: typeof at === "string" ? at : "", state };
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
/** The granted folders, by real path, sorted. */
export function grantedFolders(home) {
    return Object.entries(readFolderGrants(home))
        .filter(([, grant]) => grant.state === "granted")
        .map(([path]) => path)
        .sort();
}
/** The folders the person turned off, by real path, sorted. */
export function excludedFolders(home) {
    return Object.entries(readFolderGrants(home))
        .filter(([, grant]) => grant.state === "excluded")
        .map(([path]) => path)
        .sort();
}
/** Is this REAL folder granted? The hook and the resolver ask this and nothing else about folders. */
export function isFolderGranted(home, realFolder) {
    if (realFolder === "")
        return false;
    const grants = readFolderGrants(home);
    return Object.prototype.hasOwnProperty.call(grants, realFolder) && grants[realFolder].state === "granted";
}
/** Where a folder stands, in the resolver's vocabulary: granted, denied (turned off), or nobody decided. */
export function folderStandingOf(home, realFolder) {
    if (isFolderGranted(home, realFolder))
        return "granted";
    if (realFolder === "")
        return "undecided";
    return Object.prototype.hasOwnProperty.call(readFolderGrants(home), realFolder) ? "denied" : "undecided";
}
function write(home, folder, state, now) {
    const path = foldersPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    const next = { ...readFolderGrants(home), [folder]: { at: now.toISOString(), state } };
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`, 0o600);
}
/** Record a folder grant (or turn an excluded folder back on). CLI-only: a hook never writes this file. 0600. */
export function grantFolder(home, realFolder, now) {
    write(home, realFolder, "granted", now);
}
/** Record that the person turned this folder off, or declined it. It stops being "undecided" and can be granted again. */
export function excludeFolder(home, realFolder, now) {
    write(home, realFolder, "excluded", now);
}
//# sourceMappingURL=folder_grants.js.map