/**
 * Listing a folder-keyed agent's sessions — `D11 · A`, `scan`.
 *
 * The two folder-keyed dialects (Claude Code, Cursor) differ in how a path is
 * encoded and where a session sits under the folder, and agree on everything
 * this file does: read directory ENTRIES, `lstat` a candidate for its time, and
 * never open it.
 *
 * ⛔ **`lstat`, REGULAR FILES ONLY.** A symlink named `x.jsonl` is not a session
 * (Cursor's gate resolves for exactly that reason), and a FIFO or socket under a
 * root this client does not own is a thing a later `readFileSync` hangs on or
 * throws on. A listing that only ever `lstat`s cannot be made to block, which is
 * the property `scan` needs from the one command that walks the whole root.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
/**
 * The entries of a directory, `null` when it is simply not there, and a THROW
 * for anything else (permissions, I/O) — the caller turns a throw into the
 * agent's `unreadable` answer, so an absent store and a broken one stay apart.
 */
export function readEntries(dir) {
    try {
        return readdirSync(dir, { withFileTypes: true });
    }
    catch (err) {
        const code = err.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return null;
        throw err;
    }
}
/** One regular file's times, or null for anything that is not one. Never opens it. */
export function sessionFile(path) {
    try {
        const stat = lstatSync(path);
        return stat.isFile() ? { path, mtimeMs: stat.mtimeMs } : null;
    }
    catch {
        return null;
    }
}
/** `<dir>/<name>` for each entry that is a real directory (a symlink is not one). */
export function subdirectories(dir) {
    return (readEntries(dir) ?? [])
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, path: join(dir, entry.name) }));
}
//# sourceMappingURL=session_listing.js.map