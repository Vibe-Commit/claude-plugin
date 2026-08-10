/**
 * The `systemMessage` channel — D57 (plan §DX3), style guide §10.1.
 *
 * The only sanctioned way a hook speaks to a human. It renders to the user
 * **without** entering the agent's context, which is why it is safe and why it
 * must stay short.
 *
 * FOUR states — `CR-023d` added the fourth, and it inverts an assumption the
 * other three shared.
 *
 * **"stdout empty on the happy path" is no longer universally true.** Every
 * populated-stdout case before `capture_confirmed` was a FAILURE signal, so a
 * consumer could read "any `systemMessage`" as "something is wrong". That
 * consumer is now wrong. This is an inversion, not a shape-preserving addition,
 * which is why it is called out here rather than left to the type.
 *
 * **The fourth state is keyed per `(repo, day)`, the other three per session.**
 * `PreCompact` mints a new `session_id` mid-task, so a per-session key would fire
 * the one positive message twice in an afternoon and read as a bug; a key with no
 * day at all would fire once ever, which under-communicates on a daily tool. See
 * `repoDayNoticePath`.
 *
 * ⚠ Two hard constraints from DESIGN.md §13.7/§13.9:
 *   - stdout carries **exactly one** well-formed JSON object, or nothing.
 *     **If construction fails for ANY reason → empty stdout. The fallback is
 *     always silence.**
 *   - **No SGR escapes inside the string.** It is a JSON field rendered by Claude
 *     Code's own UI; embedded escapes are undefined behaviour.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SYSTEM_MESSAGE, URLS } from "./copy/index.js";
import { repoDayNoticePath, sessionNoticePath } from "./paths.js";
import { NODE_FLOOR_TEXT } from "./runtime.js";
/**
 * The UTC calendar day, `YYYY-MM-DD`.
 *
 * UTC and not local: a local key silently depends on the machine's timezone and
 * changes twice a year at a DST boundary, which would fire the message a second
 * time on one day in spring and skip it on one in autumn. It also matches how
 * this file already timestamps (`new Date().toISOString()`).
 */
export function utcDay(now) {
    return now.toISOString().slice(0, 10);
}
/** The one-line text for a state. Never contains an escape sequence. */
export function noticeText(state, nodeVersion) {
    switch (state) {
        case "not_connected":
            return SYSTEM_MESSAGE.notConnected;
        case "credential_revoked":
            return SYSTEM_MESSAGE.credentialRevoked;
        case "unsupported_runtime":
            return SYSTEM_MESSAGE.unsupportedRuntime(NODE_FLOOR_TEXT, nodeVersion);
        case "capture_confirmed":
            return SYSTEM_MESSAGE.captureConfirmed(URLS.dashboard);
    }
}
/**
 * Where this state's once-per-key marker lives, or null if it cannot have one.
 *
 * The whole difference between the four states is here: three are keyed on the
 * session, and `capture_confirmed` is keyed on `(repo, day)`.
 *
 * Null when `capture_confirmed` has no repo. **Refuse, do not guess** — a
 * fallback key would be shared by every repo on the machine, so the first repo
 * to capture today would silence all the others. Null becomes silence, which is
 * this channel's fallback everywhere else too.
 */
export function noticeClaimPath(ctx, state) {
    if (state !== "capture_confirmed") {
        return sessionNoticePath(ctx.home, ctx.sessionId, state);
    }
    if (ctx.repoKey === null || ctx.repoKey === "")
        return null;
    return repoDayNoticePath(ctx.home, ctx.repoKey, utcDay(ctx.now()), state);
}
/**
 * Claim the once-per-KEY slot for `state`.
 *
 * `wx` is doing real work here: it creates-or-fails atomically, so two hooks
 * firing concurrently under the same key cannot both win. A read-then-write
 * check would let both through and print the message twice. That mattered for
 * one session; it matters more now, because `capture_confirmed`'s key spans a
 * whole day and therefore many more concurrent hooks.
 *
 * Returns false on ANY failure, including an unwritable home. A message we cannot
 * record having sent is a message we do not send — repeating it every turn is
 * worse than losing it once.
 */
export function claimSessionNotice(ctx, state) {
    const path = noticeClaimPath(ctx, state);
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString() })}\n`, {
            flag: "wx",
            mode: 0o600,
        });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Render the hook's stdout payload for a state, or null.
 *
 * Null means "write nothing", and every failure resolves to null. The caller
 * writes the string verbatim and adds a trailing newline; it never builds JSON
 * itself, so there is exactly one place this contract can be broken.
 */
export function renderNotice(ctx, state) {
    try {
        const text = noticeText(state, ctx.nodeVersion);
        // A message carrying an escape sequence or a newline is undefined behaviour
        // in Claude Code's renderer, so it is dropped rather than sent — silence is
        // the fallback. Tested by char code, not by a regex holding a literal
        // control character: DESIGN.md §13.2 puts every escape sequence in one
        // module, and a literal one here would be both a violation and unreadable.
        if (hasControlCharacter(text))
            return null;
        if (!claimSessionNotice(ctx, state))
            return null;
        return JSON.stringify({ systemMessage: text });
    }
    catch {
        return null;
    }
}
/** True if `text` holds any C0 control character (including ESC) or DEL. */
export function hasControlCharacter(text) {
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}
//# sourceMappingURL=system_message.js.map