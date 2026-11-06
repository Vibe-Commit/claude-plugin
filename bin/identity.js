/**
 * THE IDENTITY DIGEST — U5a of the detached uploader (plan §3.13).
 *
 * One machine-wide worker serves every session's firing log, and a session can be started under a different credential than the one the
 * worker would find on its own: `VIBECOMMIT_TOKEN=<org B>` in one shell, the saved `org A` credential everywhere else. Without a check, the
 * worker would upload B's session under A's credential. So each firing carries a digest of "who this upload is for", the worker computes
 * its own, and **a worker serves only firings of its own identity**, in the idle drain as well.
 *
 * The digest is a sha256 of, in order:
 *  - the ingest URL (a different server is a different account),
 *  - the credential SOURCE: the constant `file` for the saved credential, and for `VIBECOMMIT_TOKEN` a hash of the token itself,
 *  - `CLAUDE_CONFIG_DIR` and `CODEX_HOME` (a different agent profile is a different set of transcripts).
 *
 * ⛔ The saved credential is a CONSTANT on purpose. A fingerprint there would strand every queued firing the moment `vibecommit auth`
 * rotates it: the worker re-reads the file every round, so rotation takes effect at once and the identity must not change with it.
 *
 * ⛔ A LEAF: it imports `node:crypto` and nothing of this package, so the hook can compute it without loading the worker. It reads a token
 * only to hash it and never returns, stores or logs it; the digest is not reversible and carries no secret.
 */
import { createHash } from "node:crypto";
/** `file`, or `env:<sha256 of the token>`. A blank `VIBECOMMIT_TOKEN` is not set (`loadCredential` agrees). */
export function credentialSourceOf(env) {
    const token = env.VIBECOMMIT_TOKEN?.trim() ?? "";
    return token === "" ? "file" : `env:${createHash("sha256").update(token).digest("hex")}`;
}
/**
 * The digest. Each field is length-prefixed, so ("ab","c") and ("a","bc") cannot collide, and an absent variable differs from an empty one
 * only if nobody can tell them apart (they behave identically), which is why both read as "".
 */
export function identityDigest(input) {
    const hash = createHash("sha256");
    for (const part of [input.url, credentialSourceOf(input.env), input.env.CLAUDE_CONFIG_DIR ?? "", input.env.CODEX_HOME ?? ""]) {
        hash.update(`${Buffer.byteLength(part)}:`);
        hash.update(part);
    }
    return hash.digest("hex");
}
//# sourceMappingURL=identity.js.map