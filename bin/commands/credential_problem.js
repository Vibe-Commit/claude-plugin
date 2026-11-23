/**
 * The credential faults, one block each — shared by `status` and `connect` (`R15`).
 *
 * `connect` used to fall through to "This machine has no ingest credential." for a wrong-class,
 * unreadable or insecure file: false, and the real fix (`chmod 600`, or `auth`) was one line away.
 * This module only names the fault. T10 (CLI UX PR-C, plan 4.12) reverses D206 §5 for `connect`: at a terminal it then replaces a
 * wrong-class FILE, or one whose form is wrong, inline (`replaceInline`), printing the block without its fix line. An insecure file, an
 * env token and (0.17.3) a file that could not be read keep their fix (a `chmod`, `auth`, or the step the block names).
 */
import { COMMANDS, CREDENTIAL, REJECTED } from "../copy/index.js";
import { metaFor } from "../credential_meta.js";
import { secretFileOf } from "../paths.js";
import { terminalSafe } from "../printable.js";
import { renderErrorBlock, truncatePath } from "../term.js";
/**
 * The three credential problems that are worth four different fixes on an
 * interactive surface. The hook collapses them to one `systemMessage`; here the
 * user can act, so §13.6 gets its full what / why / fix.
 *
 * None of these lines can carry credential bytes: the plaintext leaves
 * `IngestCredential` only through `expose()`, and no copy path calls it.
 */
export function credentialProblem(load, colour, 
/** The channel's `auth` (`installChannel`) — `vibecommit auth` on npm, `node <path> auth` for the plugin. */
authCommand = COMMANDS.auth) {
    return renderErrorBlock(credentialProblemBlock(load, authCommand), colour);
}
/**
 * 0.17.3 (P6 ruling): the faults `connect` replaces inline. ONLY a file it read that is not a credential: a wrong-class one, or one whose
 * form is wrong. A file it could NOT read (refused, not a file, a closed or unchecked folder, a failed read) may hold a credential that is
 * live on the server, and replacing it would leave that credential with nobody holding it when a `chmod` would restore it.
 */
export function replaceableInline(load) {
    return load.kind === "wrong-class" || (load.kind === "unreadable" && load.cause === "form");
}
/** P7 (0.17.3): a read-failed code prints only when it is a plain errno name. */
const ERRNO_NAME = /^[A-Z0-9_]+$/;
/**
 * The block itself, un-rendered: `--json` failures carry the same code, sentences and fix commands as the text.
 * 0.7.0 PR 7: the fix command is the one the caller gives (the channel's `auth`), never a literal.
 */
export function credentialProblemBlock(load, authCommand = COMMANDS.auth) {
    // W1 (prc1): every path is sanitised before it is shortened, so no control byte from a HOME path reaches the terminal.
    const shown = (path) => truncatePath(terminalSafe(path), 60);
    switch (load.kind) {
        case "wrong-class":
            return {
                kind: "bad",
                code: "STORED_CREDENTIAL_NOT_INGEST",
                what: CREDENTIAL.wrongClassWhat,
                why: [load.source === "env" ? CREDENTIAL.wrongClassEnvWhy : CREDENTIAL.wrongClassFileWhy],
                fixLabel: CREDENTIAL.wrongClassFix,
                fixes: [authCommand],
            };
        case "insecure-file": {
            // ONE code, several remedies: the folder's mode and the file's mode are different things to fix, and `chmod 600` on
            // the file does not clear a folder that other accounts can enter (the user would loop on this block).
            if (load.target === "directory") {
                return {
                    kind: "bad",
                    code: "CREDENTIAL_FILE_INSECURE",
                    what: CREDENTIAL.insecureDirWhat,
                    why: [`${CREDENTIAL.insecureDirWhyLabel} ${shown(load.path)}`, `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`, CREDENTIAL.insecureDirWhy],
                    fixLabel: CREDENTIAL.insecureFileFix,
                    fixes: [COMMANDS.chmodDirectory],
                };
            }
            const why = [`${CREDENTIAL.insecureFileWhyLabel} ${shown(load.path)}`, `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`];
            switch (secretFileOf(load.path)) {
                case "credentials":
                    return {
                        kind: "bad",
                        code: "CREDENTIAL_FILE_INSECURE",
                        what: CREDENTIAL.insecureFileWhat,
                        why: [...why, CREDENTIAL.insecureFileWhy],
                        fixLabel: CREDENTIAL.insecureFileFix,
                        fixes: [COMMANDS.chmodCredentials],
                    };
                // D-1: the queue's own `chmod`. Its label says "run the command again", not "reconnect": not every renderer is connect.
                case "pending-revoke":
                    return {
                        kind: "bad",
                        code: "CREDENTIAL_FILE_INSECURE",
                        what: CREDENTIAL.insecureQueueWhat,
                        why: [...why, CREDENTIAL.insecureQueueWhy],
                        fixLabel: CREDENTIAL.insecureQueueFix,
                        fixes: [COMMANDS.chmodPendingRevoke],
                    };
                case null:
                    return {
                        kind: "bad",
                        code: "CREDENTIAL_FILE_INSECURE",
                        what: CREDENTIAL.insecureOtherWhat,
                        why: [...why, CREDENTIAL.insecureOtherWhy],
                        fixLabel: CREDENTIAL.insecureOtherFix,
                    };
            }
        }
        case "unreadable":
            return unreadableBlock(load, authCommand, shown);
    }
}
/** D-2 (0.17.3): CREDENTIAL_FILE_UNREADABLE says what is true for its cause, and its fix fixes that cause. */
function unreadableBlock(load, authCommand, shown) {
    const code = "CREDENTIAL_FILE_UNREADABLE";
    const file = `${CREDENTIAL.insecureFileWhyLabel} ${shown(load.path)}`;
    const folder = `${CREDENTIAL.insecureDirWhyLabel} ${shown(load.path)}`;
    switch (load.cause) {
        // The file was read and is not a credential: today's block, byte-identical, and the one `connect` replaces inline.
        case "form":
            return { kind: "bad", code, what: CREDENTIAL.unreadableWhat, why: [file, CREDENTIAL.unreadableWhy], fixLabel: CREDENTIAL.unreadableFix, fixes: [authCommand] };
        case "read-refused": {
            // The file's own `chmod`, from the table. A path not in it gets a fix with no command (fail closed).
            const refused = { kind: "bad", code, what: CREDENTIAL.unreadableWhat, why: [file, CREDENTIAL.readRefusedWhy] };
            switch (secretFileOf(load.path)) {
                case "credentials":
                    return { ...refused, fixLabel: CREDENTIAL.readRefusedFix, fixes: [COMMANDS.chmodCredentials] };
                case "pending-revoke":
                    return { ...refused, fixLabel: CREDENTIAL.readRefusedFix, fixes: [COMMANDS.chmodPendingRevoke] };
                case null:
                    return { ...refused, fixLabel: CREDENTIAL.readRefusedOtherFix };
            }
        }
        // The folder cannot be searched: the file's `chmod` would fail the same way, so the fix is the folder's.
        case "folder-closed":
            return { kind: "bad", code, what: CREDENTIAL.folderClosedWhat, why: [folder, CREDENTIAL.folderClosedWhy], fixLabel: CREDENTIAL.folderClosedFix, fixes: [COMMANDS.chmodDirectory] };
        case "folder-unchecked":
            return { kind: "bad", code, what: CREDENTIAL.folderUncheckedWhat, why: [folder, CREDENTIAL.folderUncheckedWhy], fixLabel: CREDENTIAL.folderUncheckedFix };
        case "not-a-file":
            return { kind: "bad", code, what: CREDENTIAL.notAFileWhat, why: [file, CREDENTIAL.notAFileReadWhy], fixLabel: CREDENTIAL.notAFileFix };
        case "read-failed": {
            const named = load.code !== null && ERRNO_NAME.test(load.code) ? CREDENTIAL.readFailedWhy(terminalSafe(load.code)) : CREDENTIAL.readFailedWhyNoCode;
            return { kind: "bad", code, what: CREDENTIAL.unreadableWhat, why: [file, named], fixLabel: CREDENTIAL.readFailedFix };
        }
    }
}
/**
 * The credential-rejected block (`11A`) — §13.6 what / why / fix, fix LAST, for `connect` (after a
 * 401 from the probe) and `status` (a standing stop). The `why` says "expired" outright only when
 * the sidecar knows an `expires_at` that has passed; otherwise it names both causes, because the
 * server's 401 is opaque and a guess would read as an accusation.
 */
export function rejectedCredentialBlock(input) {
    const expires = metaFor(input.home, input.fingerprint)?.expires_at ?? null;
    const expiredAt = expires === null ? Number.NaN : Date.parse(expires);
    const body = {
        what: REJECTED.what,
        why: [
            Number.isFinite(expiredAt) && expiredAt <= input.nowMs
                ? REJECTED.whyExpired((expires ?? "").slice(0, 10))
                : REJECTED.why,
        ],
        fixLabel: REJECTED.fixLabel,
        fixes: [input.authCommand],
    };
    // A standing stop `status` reports is a warning and carries no code; the verdict `connect` just got is
    // an error and does (`CREDENTIAL_REJECTED`, the same condition `finalize` and `backfill` stop on).
    return renderErrorBlock(input.standing ? { kind: "warn", ...body } : { kind: "bad", code: "CREDENTIAL_REJECTED", ...body }, input.colour);
}
//# sourceMappingURL=credential_problem.js.map