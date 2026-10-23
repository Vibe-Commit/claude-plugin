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
    switch (load.kind) {
        case "wrong-class":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.wrongClassWhat,
                why: [
                    load.source === "env"
                        ? CREDENTIAL.wrongClassEnvWhy
                        : CREDENTIAL.wrongClassFileWhy,
                ],
                fixLabel: CREDENTIAL.wrongClassFix,
                fixes: [authCommand],
            }, colour);
        case "insecure-file":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.insecureFileWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`,
                    CREDENTIAL.insecureFileWhy,
                ],
                fixLabel: CREDENTIAL.insecureFileFix,
                fixes: [COMMANDS.chmodCredentials],
            }, colour);
        case "unreadable":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.unreadableWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    CREDENTIAL.unreadableWhy,
                ],
                fixLabel: CREDENTIAL.unreadableFix,
                fixes: [authCommand],
            }, colour);
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
    return renderErrorBlock({
        kind: input.standing ? "warn" : "bad",
        what: REJECTED.what,
        why: [
            Number.isFinite(expiredAt) && expiredAt <= input.nowMs
                ? REJECTED.whyExpired((expires ?? "").slice(0, 10))
                : REJECTED.why,
        ],
        fixLabel: REJECTED.fixLabel,
        fixes: [input.authCommand],
    }, input.colour);
}
//# sourceMappingURL=credential_problem.js.map