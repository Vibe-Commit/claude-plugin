/**
 * The ingest credential — load, carry, redact.
 *
 * THE INVARIANT, and the whole reason `/cso` is mandatory on this file: the
 * credential is an **opaque secret**. Never parse it. Never log it.
 *
 * It is NOT a JWT and must never be treated as one. W2 (`CR-009`/`CR-010`/
 * `CR-011`) found that a `vcik_` token already fails at `/mcp` for an entirely
 * incidental reason — base64url has no dots, so the JWT verifier rejects it
 * before any audience check runs. Any client that "validates" the credential by
 * decomposing it inherits that trap: it would appear to work while checking
 * something else entirely.
 *
 * ## How the plaintext is kept out of logs
 *
 * A bare `string` leaks through every ordinary path: template interpolation,
 * `JSON.stringify`, `console.error(obj)`, an unhandled rejection whose message
 * embedded it. So the plaintext never travels as a bare string — it travels
 * inside `IngestCredential`, whose `toString`, `toJSON` and Node inspect hook
 * all render `vcik_…redacted`. Reaching the plaintext requires calling
 * `expose()`, which is deliberately ugly and greppable.
 *
 * That is a real control, not a ceremony: `test/credential.test.ts` proves it can
 * go red by asserting each redaction path against the raw secret.
 *
 * ## Precedence
 *
 * `VIBECOMMIT_TOKEN` is read **BEFORE** `~/.vibecommit/credentials.json`, for
 * headless and CI use (D56 plan, founder call).
 *
 * Wire contract retyped from `vibecommit-mcp/src/oauth/ingest_credential.ts`
 * (prefix, opacity, no rotation). Nothing is imported from that package and
 * nothing may be: it is closed source and this package is MIT (D60 §D1a).
 *
 * @provenance vibecommit-mcp src/oauth/ingest_credential.ts — wire contract, retyped
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, writeFileSync, } from "node:fs";
import { inspect } from "node:util";
import { credentialsPath, rootDir } from "./paths.js";
/**
 * Retyped from `INGEST_CREDENTIAL_TOKEN_PREFIX` in the closed-source server.
 * Its job there is to make a leaked credential greppable and to keep a plaintext
 * from ever being mistaken for a hex digest. Its job HERE is narrower: refuse to
 * put a credential of the wrong class on the ingest lane.
 */
export const INGEST_TOKEN_PREFIX = "vcik_";
/** What a redacted credential renders as. Contains no bytes of the secret. */
export const REDACTED = `${INGEST_TOKEN_PREFIX}…redacted`;
/**
 * An opaque ingest credential.
 *
 * Every ordinary way of turning a value into text renders `REDACTED`. The
 * plaintext leaves only through `expose()`.
 */
export class IngestCredential {
    #secret;
    /** Where it came from. Safe to log — names a source, not a value. */
    source;
    constructor(secret, source) {
        this.#secret = secret;
        this.source = source;
    }
    /** The plaintext. The ONLY exit. Call this at the request boundary, nowhere else. */
    expose() {
        return this.#secret;
    }
    toString() {
        return REDACTED;
    }
    toJSON() {
        return REDACTED;
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return REDACTED;
    }
    get [Symbol.toStringTag]() {
        return REDACTED;
    }
}
/**
 * Read a file under `~/.vibecommit/` that holds a secret, refusing an insecure
 * one — **the two checks the human lane INHERITS rather than copies**.
 *
 * It was inline in `loadCredential` while the ingest credential was the only
 * secret on disk. `CR-084d` adds a second (the refresh token), and a second copy
 * of a security check is a second thing to forget when the first one changes —
 * so it is one function with two callers instead.
 *
 * `/cso` finding 3 (2026-08-09), MEDIUM, is the DIRECTORY half. The FILE's mode
 * was checked and the directory's was not, and the directory is the one that
 * matters for the interesting attack: a second local account cannot read a 0600
 * credentials.json, but with a writable `~/.vibecommit` it can unlink it and
 * drop in its own 0600 file. The victim's next hook then uploads their whole
 * transcript stream into the attacker's org. `grantProject` chmods the directory
 * to 0700 on first write, so a clean install is fine — this covers the directory
 * that already existed.
 */
export function readSecretFile(home, path) {
    try {
        const dir = rootDir(home);
        const dirMode = statSync(dir).mode & 0o777;
        if ((dirMode & 0o077) !== 0) {
            return { kind: "insecure-file", path: dir, mode: dirMode.toString(8).padStart(3, "0") };
        }
        // `lstat`, not `stat`: `stat` follows a symlink and would report the
        // TARGET's mode, so a link to an attacker-owned 0600 file would pass a
        // check that exists to establish who can read this one.
        const mode = lstatSync(path).mode & 0o777;
        if ((mode & 0o077) !== 0) {
            return { kind: "insecure-file", path, mode: mode.toString(8).padStart(3, "0") };
        }
        return { kind: "ok", raw: readFileSync(path, "utf8") };
    }
    catch {
        // ENOENT is the overwhelmingly common case — not connected yet.
        return { kind: "absent" };
    }
}
/**
 * Load the ingest credential. `VIBECOMMIT_TOKEN` first, then the credentials
 * file.
 *
 * Returns a discriminated union rather than throwing: the hook path must not
 * take an exception for a missing credential, and the interactive path wants to
 * distinguish the four not-ok outcomes to print four different fixes.
 */
export function loadCredential(ctx) {
    const fromEnv = ctx.env.VIBECOMMIT_TOKEN;
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
        const secret = fromEnv.trim();
        if (!secret.startsWith(INGEST_TOKEN_PREFIX)) {
            return { kind: "wrong-class", source: "env" };
        }
        return { kind: "ok", credential: new IngestCredential(secret, "env") };
    }
    const path = credentialsPath(ctx.home);
    const read = readSecretFile(ctx.home, path);
    if (read.kind !== "ok")
        return read;
    const raw = read.raw;
    let token;
    try {
        // Parsing the FILE is not parsing the CREDENTIAL. The file is our own JSON
        // envelope; the credential is the opaque string inside it and stays opaque.
        token = JSON.parse(raw).token;
    }
    catch {
        return { kind: "unreadable", path };
    }
    if (typeof token !== "string" || token.trim() === "") {
        return { kind: "unreadable", path };
    }
    const secret = token.trim();
    if (!secret.startsWith(INGEST_TOKEN_PREFIX)) {
        return { kind: "wrong-class", source: "file" };
    }
    return { kind: "ok", credential: new IngestCredential(secret, "file") };
}
/**
 * Persist the ingest credential. 0700 on the directory, 0600 on the file.
 *
 * `CR-216/U1`. Until this existed the module was a reader with no producer:
 * `loadCredential` parsed an envelope, `readSecretFile` policed its modes and
 * `copy/strings.ts:1412` told the user to `chmod 600` it, but nothing in the
 * package ever wrote it. The only credential that reached a hook came from
 * `VIBECOMMIT_TOKEN`, so a commit from a shell without it exported bound nothing
 * and said nothing — the hook's exit contract makes a missing credential silent
 * on purpose, which is right for the hook and fatal for a first install.
 *
 * ⚠ THE TWO `chmod`s AFTER THE WRITES ARE NOT REDUNDANT, and this is the third
 * time this package has had to say so (`consent.ts`'s `grantProject` first, then
 * `oauth/session.ts:139`). `writeFileSync`'s `mode` is masked by the umask, and
 * it is IGNORED ENTIRELY when the file already exists — so the re-auth after a
 * rotation, which is exactly the write that follows a leak, would silently
 * inherit whatever mode was there before.
 *
 * The refusal below is the write-side half of the class check. The read side
 * already refuses a token of the wrong class in both directions (see
 * `CredentialLoad`'s `wrong-class`); this is the third door into the same slot,
 * and a door that admits what the others refuse is not a door with a check.
 * It refuses BEFORE touching the disk: a half-written envelope would load as
 * `unreadable` rather than `absent`, sending the user to a different fix.
 *
 * The single `expose()` here is unavoidable — persisting a secret means writing
 * its bytes — and greppable, which is the property the wrapper buys.
 *
 * @throws if handed a credential of the wrong class. The message carries the
 * class, never the rejected bytes.
 */
export function saveCredential(home, credential) {
    const secret = credential.expose();
    if (!secret.startsWith(INGEST_TOKEN_PREFIX)) {
        throw new Error(`refusing to persist a credential that is not an ingest credential: expected a ${INGEST_TOKEN_PREFIX}… token`);
    }
    const path = credentialsPath(home);
    mkdirSync(rootDir(home), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    writeFileSync(path, `${JSON.stringify({ token: secret }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
}
/**
 * Is there a saved credential for `VIBECOMMIT_TOKEN` to be shadowing?
 *
 * `CR-216/U3`. PRESENCE, not validity, and the distinction is the point: this
 * answers "is the env var overriding something?", and a file that is present but
 * unreadable or wrongly-moded is still something being overridden — arguably the
 * case most worth saying out loud, since the user who saved it believes it is in
 * use. Validity is `loadCredential`'s question and it answers it separately.
 *
 * Deliberately not `loadCredential({ env: {} , home })`: that would silently
 * return `absent` for an insecure file and suppress the warning exactly where a
 * user is most confused about which credential is live.
 */
export function savedCredentialExists(home) {
    return existsSync(credentialsPath(home));
}
/**
 * Belt and braces for the `inspect` path specifically.
 *
 * `util.inspect` honours the custom symbol on the instance, but a credential
 * nested inside a plain object that someone stringifies with `%o` should also
 * come out redacted. Exposed so tests can assert it rather than assume it.
 */
export function describeCredential(value) {
    return inspect(value, { depth: 3 });
}
// ---------------------------------------------------------------------------
// CR-084d — THE SECOND SLOT: the human lane's user-principal tokens.
//
// One sign-in, two token classes, and they are kept apart on purpose:
//
//   * the OPAQUE ingest credential above (`vcik_`), long-lived, no rotation,
//     machine-scoped, for the hook lane;
//   * a REFRESH TOKEN and a short-lived ACCESS TOKEN below, user-scoped, for the
//     read lane's `tools/call` against `/mcp`.
//
// ⚠ `loadCredential`'s `wrong-class` refusal above is NOT widened, and widening
// it is the obvious wrong move a later reader will make. `credential.ts:96-102`
// says why: a control-plane token on the data plane is a privilege class
// crossing a lane, and the server's audience wall rejecting it too is defence in
// depth rather than a reason to try. The refusal is now mirrored in BOTH
// directions — a `vcik_` put in the refresh slot is refused just as a JWT put in
// the ingest slot is — so neither lane can be fed the other's secret by a
// copy-paste into the wrong file.
//
// ⚠ AND THE REDACTION DISCIPLINE IS NOT CEREMONY HERE EITHER — it matters MORE.
// The module note at the top of this file lists the four leak paths a bare
// `string` has (template interpolation, `JSON.stringify`, `console.error(obj)`,
// an unhandled rejection whose message embedded it). A user-principal token has
// MORE authority than an ingest credential: it reads a user's history rather
// than appending to one org's. Shipping it as a bare string would reopen that
// whole leak class on the more dangerous secret, so both classes below carry the
// same four renderers and the same deliberately-ugly `expose()`.
//
// @provenance vibecommit-mcp src/oauth/refresh.ts — 32-byte base64url opaque refresh token, retyped
// @provenance vibecommit-mcp src/oauth/token.ts — RFC 6749 §5.1 token response shape, retyped
// ---------------------------------------------------------------------------
/** What a redacted refresh token renders as. Contains no bytes of the secret. */
export const REDACTED_REFRESH = "refresh…redacted";
/** What a redacted access token renders as. Contains no bytes of the secret. */
export const REDACTED_ACCESS = "access…redacted";
/**
 * The base of both user-principal token types.
 *
 * A shared base rather than two copies: every redaction path is defined once, so
 * a fifth rendering path discovered later is closed for both at once. The marker
 * is per-subclass because a redacted string that could not say WHICH token it
 * stood for would make a log line ambiguous exactly when someone is debugging an
 * auth failure.
 */
class OpaqueToken {
    #secret;
    constructor(secret) {
        this.#secret = secret;
    }
    /** The plaintext. The ONLY exit. Call this at the request boundary, nowhere else. */
    expose() {
        return this.#secret;
    }
    toString() {
        return this.marker();
    }
    toJSON() {
        return this.marker();
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.marker();
    }
    get [Symbol.toStringTag]() {
        return this.marker();
    }
}
/**
 * The long-lived half of the human lane: rotated on every use, 90-day family cap.
 *
 * ⚠ Presenting one twice is a REPLAY to the server and revokes the whole family
 * (`refresh.ts`'s `reuse_detected`). That is why `oauth/lock.ts` exists — see
 * its module note, which is the single most consequential comment in this task.
 */
export class RefreshToken extends OpaqueToken {
    constructor(secret) {
        super(secret);
    }
    marker() {
        return REDACTED_REFRESH;
    }
}
/**
 * The short-lived half: an RS256 JWT, `aud` = the `/mcp` audience, ~900 seconds.
 *
 * Held as an opaque token DESPITE being a JWT, and the distinction is worth
 * stating: a JWT's payload is readable by anyone holding it, so "opaque" here is
 * about not LOGGING it, not about not parsing it. Nothing in this client parses
 * it — the expiry travels beside it as data from the token response, because
 * trusting a claim inside a token to decide whether to refresh that token is
 * asking the thing being validated to validate itself.
 */
export class AccessToken extends OpaqueToken {
    constructor(secret) {
        super(secret);
    }
    marker() {
        return REDACTED_ACCESS;
    }
}
/**
 * Is this string a refresh token rather than something else in the wrong slot?
 *
 * The server mints it as 32 random bytes, base64url-encoded and unpadded
 * (`refresh.ts`'s `mintRefreshToken`). It therefore has NO dots — so a JWT is
 * refused — and it does not carry the ingest prefix, so a `vcik_` is refused.
 *
 * ⚠ This is a CLASS check, not a validity check. It answers "is this the right
 * KIND of secret for this slot", which is a question the client can answer
 * locally; whether the token is live is the server's answer and is never guessed
 * here. Same discipline as the ingest credential: never parse the secret.
 */
export function isRefreshTokenShape(value) {
    if (value === "" || value.startsWith(INGEST_TOKEN_PREFIX))
        return false;
    return /^[A-Za-z0-9_-]+$/.test(value);
}
/**
 * Is this string an access token rather than something else in the wrong slot?
 *
 * Three non-empty dot-separated base64url segments — the JWS Compact
 * Serialization shape (RFC 7515 §3.1). This is the mirror of the trap recorded
 * at the top of this file: a `vcik_` is base64url with NO dots, so it fails here
 * for the same structural reason it fails the server's JWT verifier, and it
 * cannot be smuggled into the bearer position of a read.
 */
export function isAccessTokenShape(value) {
    const parts = value.split(".");
    return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}
//# sourceMappingURL=credential.js.map