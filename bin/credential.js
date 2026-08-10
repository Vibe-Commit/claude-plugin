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
import { lstatSync, readFileSync, statSync } from "node:fs";
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
    const dir = rootDir(ctx.home);
    const path = credentialsPath(ctx.home);
    let raw;
    try {
        // `/cso` finding 3 (2026-08-09), MEDIUM. The FILE's mode was checked and the
        // DIRECTORY's was not, and the directory is the one that matters for the
        // interesting attack: a second local account cannot read a 0600
        // credentials.json, but with a writable ~/.vibecommit it can unlink it and
        // drop in its own 0600 file. The victim's next hook then uploads their whole
        // transcript stream into the attacker's org. `grantProject` chmods the
        // directory to 0700 on first write, so a clean install is fine — this covers
        // the directory that already existed.
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
        raw = readFileSync(path, "utf8");
    }
    catch {
        // ENOENT is the overwhelmingly common case — not connected yet.
        return { kind: "absent" };
    }
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
 * Belt and braces for the `inspect` path specifically.
 *
 * `util.inspect` honours the custom symbol on the instance, but a credential
 * nested inside a plain object that someone stringifies with `%o` should also
 * come out redacted. Exposed so tests can assert it rather than assume it.
 */
export function describeCredential(value) {
    return inspect(value, { depth: 3 });
}
//# sourceMappingURL=credential.js.map