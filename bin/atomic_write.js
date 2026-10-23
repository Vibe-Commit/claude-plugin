/**
 * Write a file so that no reader ever sees half of it — temp file in the SAME
 * directory, then `rename`.
 *
 * `rename(2)` within one filesystem replaces the destination in one step, so a
 * hook that reads `credentials.json` while `auth` is saving gets the old file or
 * the new one and never a torn one (`FC5`). The temp file is created `wx` at the
 * final mode, so the bytes are never readable by group or other even briefly,
 * and the `chmod` after is the same belt `saveCredential` has always worn
 * (`writeFileSync`'s `mode` is masked by the umask).
 *
 * A failure removes the temp file and rethrows: the destination is untouched.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
export function writeFileAtomic(path, data, mode) {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, data, { mode, flag: "wx" });
        chmodSync(tmp, mode);
        renameSync(tmp, path);
    }
    catch (error) {
        try {
            unlinkSync(tmp);
        }
        catch {
            /* nothing to clean up */
        }
        throw error;
    }
}
//# sourceMappingURL=atomic_write.js.map