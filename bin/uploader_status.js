/**
 * THE UPLOAD WORKER'S STATUS FILE — U6 (plan §3.7). `uploader.<id>.status`, written atomically by the worker after every step and read by the next
 * hook (notices) and by `status` (U7). A LEAF: it imports `node:fs` and `paths` only, so the hook can read it without loading the worker.
 *
 * Counts, classes and times only. Never a body, a path, a session id or a credential. `rejected` holds a credential FINGERPRINT (a hash, the key the
 * notice claims and the credential-meta sidecar already use), so the hook can tell "the server rejected the credential I am about to use" from
 * "it rejected one that has since been replaced" without the worker keeping the credential.
 */
import { readFileSync } from "node:fs";
import { uploaderStatusPath } from "./paths.js";
/** The status file for this identity, or null when absent, unreadable or not this version's shape. Never throws. */
export function readUploaderStatus(home, identity) {
    try {
        const parsed = JSON.parse(readFileSync(uploaderStatusPath(home, identity), "utf8"));
        if (parsed === null || typeof parsed !== "object" || parsed.v !== 1)
            return null;
        if (typeof parsed.heartbeatAt !== "number" || !Array.isArray(parsed.outcomes))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=uploader_status.js.map