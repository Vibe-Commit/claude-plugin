/**
 * `GET /ingest/v1/whoami` — does the server still accept this credential, and whose is it?
 *
 * The probe `connect` runs BEFORE it sends (R12) and `auth` runs on a credential it is about to
 * replace and on the one it just minted. Slice 1's answer to G1: `connect` printed "Capturing" over a
 * dead credential because nothing asked the server.
 *
 * ```
 *   GET <ingest origin>/ingest/v1/whoami          Authorization: Bearer vcik_…
 *   200 { credential_id, org_id, org_name, expires_at, account }   account = GitHub handle | null
 *   401 { "error": "unauthorized" }                opaque — the reason is in the server's logs only
 * ```
 *
 * ⛔ THREE OUTCOMES, AND ONLY ONE OF THEM IS "DEAD". `unauthorized` is a 401 and nothing else.
 * Everything that is not a clean 200 or a clean 401 — a 5xx, a 404 from a server that predates the
 * route, a timeout, a network error, a body that is not what the contract says — is `unavailable`:
 * the server did not answer the question, so the caller must not conclude the credential is dead
 * (that is the "a blip is not a failed install" rule, `connect.ts`).
 *
 * The server stamps `last_used_at` for a probe and never `last_ingest_at`, so a whoami is not a
 * capture in Settings.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — GET /ingest/v1/whoami request and response, retyped
 */
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from "../version.js";
export const WHOAMI_PATH = "/ingest/v1/whoami";
/** Long enough for a healthy server, short enough that `connect` never feels hung (R12). */
export const WHOAMI_TIMEOUT_MS = 2_000;
/** The probe URL, on the same origin as the ingest URL the credential is sent to. */
export function whoamiUrl(ingestUrl) {
    return new URL(WHOAMI_PATH, ingestUrl).toString();
}
const nonEmpty = (v) => typeof v === "string" && v !== "";
export async function whoami(ingestUrl, credential, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? WHOAMI_TIMEOUT_MS);
    try {
        const res = await deps.fetch(whoamiUrl(ingestUrl), {
            method: "GET",
            headers: {
                // The request boundary — a credential's plaintext is used here and in `post.ts`.
                authorization: `Bearer ${credential.expose()}`,
                accept: "application/json",
                [CLIENT_VERSION_HEADER.toLowerCase()]: CLIENT_VERSION,
            },
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status === 401)
            return { kind: "unauthorized" };
        if (res.status !== 200)
            return { kind: "unavailable" };
        // The timer stays armed through the body: a server that sends headers and then stalls is
        // still a probe that must not hang `connect`.
        const doc = (await res.json());
        if (typeof doc !== "object" || doc === null)
            return { kind: "unavailable" };
        if (!nonEmpty(doc.credential_id) || !nonEmpty(doc.org_id) || !nonEmpty(doc.org_name)) {
            return { kind: "unavailable" };
        }
        return {
            kind: "ok",
            credentialId: doc.credential_id,
            orgId: doc.org_id,
            orgName: doc.org_name,
            expiresAt: nonEmpty(doc.expires_at) ? doc.expires_at : null,
            account: nonEmpty(doc.account) ? doc.account : null,
        };
    }
    catch {
        return { kind: "unavailable" };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=whoami.js.map