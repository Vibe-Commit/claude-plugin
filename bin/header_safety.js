/**
 * The ONE shared byte-safety predicate every outgoing header value is checked
 * against before this client puts it on the wire — `TODOS[182]`.
 *
 * ## Why a predicate, not `new Headers()`
 *
 * `new Headers(value)` throws a `TypeError` on most unsendable bytes (a
 * character above U+00FF, a bare LF/CR, NUL) — but MEASURED (node 22.17,
 * `vg-evidence/182-design-review/`) it does NOT throw on `\x01`, `\x1f` or DEL
 * (`\x7f`): those pass `Headers()` silently and only fail once `fetch` itself
 * is called, with a `TypeError` whose shape ("fetch failed") is
 * INDISTINGUISHABLE from a real network outage (a refused connection and a DNS
 * failure throw the identical constructor and message, differing only in
 * `cause.code`). Catching this class of value at `fetch`'s own throw would
 * misclassify it as `later` and retry the SAME unsendable bytes forever — the
 * exact stall this module exists to prevent.
 *
 * `Headers()` also silently STRIPS leading and trailing whitespace (OWS)
 * rather than rejecting it, so a value like `"agent-x "` would arrive at the
 * server as `"agent-x"` — a different string than the one this client actually
 * examined. This predicate rejects that case too, rather than letting
 * `Headers()` rewrite a value out from under it.
 *
 * `new Headers()` still runs as a SECONDARY, defense-in-depth check after this
 * predicate (see `post.ts`'s `attemptSend`) — it catches anything a future
 * undici version rejects that this hand-written predicate did not anticipate.
 * It is never the PRIMARY check.
 */
export function headerSafe(value) {
    if (value !== value.trim())
        return false;
    return /^[\x20-\x7E\x80-\xFF]*$/.test(value);
}
/**
 * `X-Session-Id`'s own, TIGHTER charset — a strict subset of `headerSafe`'s
 * general rule, so the two can never disagree about a session id that passes
 * both. A session id is a token, never free text: Claude Code's are UUIDs
 * (ASCII, 36 chars), so there is no legitimate reason for one to carry a space
 * or a byte from the Latin-1 supplement, both of which `headerSafe` alone
 * would still allow. The length bound (1..200) is the server's own
 * `SESSION_ID_MAX`, enforced here because the server 400s an id over it but
 * nothing on the hook path ever checked the charset side, which is the gap
 * `fetch`'s indistinguishable-from-network-failure throw exploits.
 */
export function sessionIdSafe(value) {
    return /^[\x21-\x7E]{1,200}$/.test(value);
}
//# sourceMappingURL=header_safety.js.map