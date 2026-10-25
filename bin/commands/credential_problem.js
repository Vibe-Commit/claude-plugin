/**
 * The credential faults, one block each — shared by `status` and `connect` (`R15`).
 *
 * `connect` used to fall through to "This machine has no ingest credential." for a wrong-class,
 * unreadable or insecure file: false, and the real fix (`chmod 600`, or `auth`) was one line away.
 * It still never MINTS over a fault (D206 §5) — it only names the fault correctly.
 */
import { COMMANDS, CREDENTIAL, REJECTED } from "../copy/index.js";
import { metaFor } from "../credential_meta.js";
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
 * The block itself, un-rendered: `--json` failures carry the same code, sentences and fix commands as the text.
 * 0.7.0 PR 7: the fix command is the one the caller gives (the channel's `auth`), never a literal.
 */
export function credentialProblemBlock(load, authCommand = COMMANDS.auth) {
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
        case "insecure-file":
            return {
                kind: "bad",
                code: "CREDENTIAL_FILE_INSECURE",
                // ONE code, two remedies: the folder's mode and the file's mode are different things to fix, and `chmod 600` on
                // the file does not clear a folder that other accounts can enter (the user would loop on this block).
                what: load.target === "directory" ? CREDENTIAL.insecureDirWhat : CREDENTIAL.insecureFileWhat,
                why: [
                    `${load.target === "directory" ? CREDENTIAL.insecureDirWhyLabel : CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`,
                    load.target === "directory" ? CREDENTIAL.insecureDirWhy : CREDENTIAL.insecureFileWhy,
                ],
                fixLabel: CREDENTIAL.insecureFileFix,
                fixes: [load.target === "directory" ? COMMANDS.chmodDirectory : COMMANDS.chmodCredentials],
            };
        case "unreadable":
            return {
                kind: "bad",
                code: "CREDENTIAL_FILE_UNREADABLE",
                what: CREDENTIAL.unreadableWhat,
                why: [`${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`, CREDENTIAL.unreadableWhy],
                fixLabel: CREDENTIAL.unreadableFix,
                fixes: [authCommand],
            };
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