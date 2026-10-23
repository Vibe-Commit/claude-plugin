/**
 * Ask the server whether a credential is still accepted, and remember what it said — `R12`, `R10`.
 *
 * One function for `connect` (the gate before its send) and `browser_credential` (the old credential
 * before sign-in, the new one before it is saved). A 200 also refreshes the sidecar: the whoami 200
 * handler is one of its three writers, and it is how a pasted or `VIBECOMMIT_TOKEN` credential, which
 * was never minted here, comes to have an `expires_at` the client can say "expired" from.
 */
import { loadedFingerprints, recordCredentialMeta } from "../credential_meta.js";
import { whoami } from "../oauth/whoami.js";
import { credentialFingerprint, ingestUrl } from "../post.js";
export async function probeCredential(ctx, credential, fetchImpl = fetch, options = {}) {
    const url = ingestUrl(ctx.env);
    // An override we refuse to send to is not a server that answered.
    if (url === null)
        return { kind: "unavailable" };
    const result = await whoami(url, credential, { fetch: fetchImpl });
    if (result.kind === "ok" && options.record !== false) {
        recordCredentialMeta(ctx.home, credentialFingerprint(credential), {
            expires_at: result.expiresAt,
            credential_id: result.credentialId,
            org_id: result.orgId,
            account: result.account,
            seen_at: ctx.now().toISOString(),
        }, loadedFingerprints(ctx.home, ctx.env));
    }
    return result;
}
//# sourceMappingURL=probe.js.map