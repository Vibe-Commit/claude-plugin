/**
 * D-TEMP (cli-ux PR-A T5): the temporary roots. One list, read by the picker's classifier (`picker.ts`), by the production context
 * (`cli.ts` sets `CommandContext.tempRoots` from it), and by the cell that proves the production context holds every root.
 *
 * Kept in its own module so `cli.ts` can import it without loading the picker, and so nothing imports a cycle.
 */
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
/** The fixed roots. `os.tmpdir()` is added by `defaultTempRoots`, because it is per-user on macOS (`/var/folders/…/T`). */
export const TEMP_ROOT_NAMES = ["/tmp", "/private/tmp", "/var/folders", "/private/var/folders", "/var/tmp", "/private/var/tmp"];
/** The realpath, or the path itself when it does not exist (CI is Linux, which has no `/private/var`). */
export function safeRealpath(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
/** Every default temporary root: `os.tmpdir()` and the fixed list, each realpath'd where it exists. */
export function defaultTempRoots(tmp = tmpdir()) {
    return [tmp, ...TEMP_ROOT_NAMES].map(safeRealpath);
}
//# sourceMappingURL=temp_roots.js.map