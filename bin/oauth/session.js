/**
 * The signed-in session on disk — the human lane's persistence.
 *
 * Lands in `~/.vibecommit/session.json` and therefore inherits the two checks
 * `credential.ts`'s `readSecretFile` makes: the DIRECTORY must not be writable
 * by group or other (`/cso` finding 3 — a writable `~/.vibecommit` lets a second
 * local account unlink the file and drop in its own), and the FILE must not be
 * readable by group or other, checked with `lstat` so a symlink cannot report
 * its target's mode instead.
 *
 * ## What is stored, and what deliberately is not
 *
 * The refresh token, the access token, the access token's expiry as an epoch
 * millisecond, and the two discovered endpoints. **Not** the code verifier or
 * the `state` — both are per-attempt secrets that die with the sign-in that
 * minted them, and a verifier surviving on disk would let a stolen code be
 * exchanged later by whoever could read the file.
 *
 * The endpoints are cached because a read verb that re-ran discovery on every
 * invocation would put two network round trips in front of every command, and
 * because the ISSUER is the value RFC 9207's `iss` check compares against — so
 * it has to be the one this session was established with, not whatever the
 * server says today.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AccessToken, RefreshToken, isAccessTokenShape, isRefreshTokenShape, readSecretFile, } from "../credential.js";
import { rootDir, sessionPath } from "../paths.js";
import { EXPIRY_SKEW_MS } from "./token.js";
/** Has the access token expired, allowing for the refresh margin? */
export function isFresh(session, nowMs) {
    return session.tokens.expiresAtMs - EXPIRY_SKEW_MS > nowMs;
}
/**
 * Read the session.
 *
 * Returns a discriminated union rather than throwing, for the same reason
 * `loadCredential` does: the caller wants to distinguish "not signed in" from
 * "signed in but the file is unsafe" so it can print two different fixes.
 */
export function loadSession(home) {
    const path = sessionPath(home);
    const read = readSecretFile(home, path);
    if (read.kind !== "ok")
        return read;
    let doc;
    try {
        doc = JSON.parse(read.raw);
    }
    catch {
        return { kind: "unreadable", path };
    }
    const { refresh_token: refresh, access_token: access } = doc;
    if (typeof refresh !== "string" || typeof access !== "string") {
        return { kind: "unreadable", path };
    }
    // Class before shape-of-envelope: a `vcik_` here is the interesting mistake,
    // and reporting it as "unreadable" would send the user to fix the wrong thing.
    if (!isRefreshTokenShape(refresh) || !isAccessTokenShape(access)) {
        return { kind: "wrong-class", path };
    }
    if (typeof doc.expires_at_ms !== "number" ||
        !Number.isFinite(doc.expires_at_ms) ||
        typeof doc.issuer !== "string" ||
        doc.issuer === "" ||
        typeof doc.token_endpoint !== "string" ||
        doc.token_endpoint === "") {
        return { kind: "unreadable", path };
    }
    return {
        kind: "ok",
        session: {
            tokens: {
                access: new AccessToken(access),
                refresh: new RefreshToken(refresh),
                expiresAtMs: doc.expires_at_ms,
                scope: typeof doc.scope === "string" ? doc.scope : "",
            },
            issuer: doc.issuer,
            tokenEndpoint: doc.token_endpoint,
        },
    };
}
/**
 * Write the session. 0700 on the directory, 0600 on the file.
 *
 * `chmod` after `writeFileSync` for both, because `writeFileSync`'s `mode` is
 * masked by the umask and is IGNORED ENTIRELY when the file already exists — so
 * a session rewritten after a rotation would silently inherit whatever mode the
 * previous write left. `consent.ts`'s `grantProject` learned this first; this is
 * the same two lines for the same reason.
 *
 * The two `expose()` calls here are the only ones outside the request boundary,
 * and they are unavoidable: persisting a secret means writing its bytes. They
 * are greppable, which is the property the wrapper buys.
 */
export function saveSession(home, session) {
    const path = sessionPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    const body = {
        refresh_token: session.tokens.refresh.expose(),
        access_token: session.tokens.access.expose(),
        expires_at_ms: session.tokens.expiresAtMs,
        scope: session.tokens.scope,
        issuer: session.issuer,
        token_endpoint: session.tokenEndpoint,
    };
    writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
//# sourceMappingURL=session.js.map