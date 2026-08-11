/**
 * PKCE (RFC 7636) and the authorization-request `state` — `CR-084d`.
 *
 * Two secrets are minted here and both are one-shot: the `code_verifier`, which
 * is what stops an attacker who steals the authorization code from exchanging
 * it, and `state`, which is what stops an attacker who can reach the loopback
 * listener from injecting THEIR code into OUR flow.
 *
 * **`S256` is the only method, and it is a TYPE and not a default.** The server
 * advertises `code_challenge_methods_supported: ["S256"]` and rejects `plain`
 * (its `verifyPkce` recomputes the SHA-256 unconditionally), so a client that
 * downgraded would not be refused by an obvious error — it would send a
 * challenge the server hashes anyway and fail as `invalid_grant`, which reads as
 * a config problem. Making the literal the field's type means the downgrade
 * cannot compile, and `test/oauth-pkce.test.ts` proves the challenge really is
 * the digest rather than the verifier copied across.
 *
 * @provenance vibecommit-mcp src/oauth/token.ts — `verifyPkce` base64url-of-SHA-256 rule, retyped
 * @provenance vibecommit-mcp src/oauth/discovery.ts — `code_challenge_methods_supported`, retyped
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
/**
 * The one supported challenge method. Declared `const` so it is a literal type:
 * `method: "S256"` cannot be assigned `"plain"` anywhere downstream.
 */
export const CHALLENGE_METHOD = "S256";
/**
 * 32 random bytes, which base64url-encode to exactly 43 characters — the FLOOR
 * of RFC 7636 §4.1's 43..128 range, and the server enforces that range verbatim
 * (`codeVerifier.length < 43 || > 128` → PKCE mismatch). 32 bytes is also the
 * size the digest itself is, so a longer verifier buys no entropy the challenge
 * can carry.
 */
const VERIFIER_BYTES = 32;
/** `state` needs unguessability, not length. 32 bytes matches the verifier. */
const STATE_BYTES = 32;
/** RFC 4648 §5 base64url, unpadded — the encoding both ends of PKCE use. */
export function base64url(bytes) {
    return bytes.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}
/**
 * Mint a fresh verifier and its challenge.
 *
 * `randomBytes` and not `Math.random`: this is the value an attacker must guess
 * to exchange a stolen code, so it comes from the CSPRNG or it is decoration.
 */
export function generatePkce() {
    const verifier = base64url(randomBytes(VERIFIER_BYTES));
    return { verifier, challenge: challengeFor(verifier), method: CHALLENGE_METHOD };
}
/** base64url(SHA-256(verifier)) — the server recomputes exactly this. */
export function challengeFor(verifier) {
    return base64url(createHash("sha256").update(verifier).digest());
}
/** A fresh per-attempt `state`. Never reused across sign-ins. */
export function generateState() {
    return base64url(randomBytes(STATE_BYTES));
}
/**
 * Compare two `state` values without leaking the position of the first
 * difference.
 *
 * The timing channel here is thin — an attacker would need many attempts against
 * a listener that closes after one — but the comparison is one line either way,
 * and `===` on a secret is the habit that matters. Lengths are compared first
 * because `timingSafeEqual` THROWS on a length mismatch rather than returning
 * false, which would turn a wrong-length callback into an unhandled exception on
 * the sign-in path.
 */
export function statesMatch(expected, presented) {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(presented, "utf8");
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(a, b);
}
//# sourceMappingURL=pkce.js.map