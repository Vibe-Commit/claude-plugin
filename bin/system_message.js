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
import { COMMANDS, SYSTEM_MESSAGE, URLS } from "./copy/index.js";
import { endDateText } from "./credential_meta.js";
import { cloneMarkerPath, machineDayNoticePath, machineEpochNoticePath, repoDayNoticePath, sessionNoticePath, } from "./paths.js";
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
/** `COMMANDS.auth` — what a notice names when the caller did not say how this install is run. */
const DEFAULT_AUTH_COMMAND = COMMANDS.auth;
const DEFAULT_CONNECT_COMMAND = COMMANDS.connect;
/** The one-line text for a state. Never contains an escape sequence. */
export function noticeText(state, nodeVersion, authCommand = DEFAULT_AUTH_COMMAND, endsAt, extras = {}) {
    switch (state) {
        case "credential_ending": {
            const date = endsAt === undefined ? null : endDateText(endsAt);
            // No date, no message: a "ends ..." line with a blank in it is worse than silence. The caller
            // treats an empty text as "write nothing".
            if (date === null)
                return "";
            const line = SYSTEM_MESSAGE.credentialEnding(date, authCommand);
            return line.length <= SYSTEM_MESSAGE.credentialRejectedBudget
                ? line
                : SYSTEM_MESSAGE.credentialEndingFallback(date);
        }
        case "not_connected": {
            // The same ≤120 budget and fallback as state 2: a long plugin realpath would blow it, and a truncated command is worse
            // than the page that always works. On npm the line is 87 characters and the bytes are what they always were.
            const line = SYSTEM_MESSAGE.notConnected(extras.connectCommand ?? DEFAULT_CONNECT_COMMAND);
            return line.length <= SYSTEM_MESSAGE.credentialRejectedBudget ? line : SYSTEM_MESSAGE.notConnectedFallback;
        }
        case "credential_revoked": {
            // ≤120 characters (`11A`). A long plugin realpath would blow it, and a truncated command is
            // worse than no command: the fallback points at the page that always works.
            const line = SYSTEM_MESSAGE.credentialRejected(authCommand);
            return line.length <= SYSTEM_MESSAGE.credentialRejectedBudget
                ? line
                : SYSTEM_MESSAGE.credentialRejectedFallback;
        }
        case "unsupported_runtime":
            return SYSTEM_MESSAGE.unsupportedRuntime(NODE_FLOOR_TEXT, nodeVersion);
        case "capture_confirmed":
            return SYSTEM_MESSAGE.captureConfirmed(URLS.dashboard);
        case "hooks_added":
            return SYSTEM_MESSAGE.hooksAdded;
        case "hooks_path_set":
            return SYSTEM_MESSAGE.hooksPathSet;
        case "own_commit_hook":
            return SYSTEM_MESSAGE.ownCommitHook;
        case "grants_unreadable":
            return SYSTEM_MESSAGE.grantsUnreadable;
        case "account_grants_unnamed":
            {
                // No count, no message: "grants 0 repositories" is not a thing to say. The caller treats an empty text as "write nothing".
                const owners = extras.unnamedOwners ?? 0;
                const repos = extras.unnamedRepos ?? 0;
                if (!(owners > 0 || repos > 0))
                    return "";
                const line = SYSTEM_MESSAGE.accountGrantsNotHere(owners, repos);
                return line.length <= SYSTEM_MESSAGE.credentialRejectedBudget ? line : SYSTEM_MESSAGE.accountGrantsNotHereFallback;
            }
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
    // State 9 is about the MACHINE's file, so it is once per (machine, day): a repo or session key would repeat it
    // in every checkout, and "once ever" would go quiet for a file that is still broken tomorrow.
    if (state === "grants_unreadable")
        return machineDayNoticePath(ctx.home, utcDay(ctx.now()), state);
    // State 10 is about the ACCOUNT's grants, so it is once per (machine, account epoch): spoken again only when the grants changed.
    // No epoch means no claim, and no claim is silence — never a shared key.
    if (state === "account_grants_unnamed") {
        return ctx.accountEpoch === undefined ? null : machineEpochNoticePath(ctx.home, ctx.accountEpoch, state);
    }
    // States 6-8 are once per CLONE. No clone key means no claim, and no claim is silence — never a shared key.
    if (state === "hooks_added" || state === "hooks_path_set" || state === "own_commit_hook") {
        return ctx.cloneKey === undefined || ctx.cloneKey === ""
            ? null
            : cloneMarkerPath(ctx.home, ctx.cloneKey, state);
    }
    if (state === "credential_ending") {
        // Per MACHINE and day, and per credential: replacing it re-arms (a new credential has a new end).
        return machineDayNoticePath(ctx.home, utcDay(ctx.now()), `${state}-${ctx.fingerprint ?? "unknown"}`);
    }
    if (state !== "capture_confirmed") {
        // State 2 is keyed by the credential too (`11A`); fingerprints are hex, so the path stays clean.
        const key = state === "credential_revoked" && ctx.fingerprint !== undefined
            ? `${state}-${ctx.fingerprint}`
            : state;
        return sessionNoticePath(ctx.home, ctx.sessionId, key);
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
        const text = noticeText(state, ctx.nodeVersion, ctx.authCommand, ctx.endsAt, {
            ...(ctx.connectCommand === undefined ? {} : { connectCommand: ctx.connectCommand }),
            ...(ctx.unnamedOwners === undefined ? {} : { unnamedOwners: ctx.unnamedOwners }),
            ...(ctx.unnamedRepos === undefined ? {} : { unnamedRepos: ctx.unnamedRepos }),
        });
        if (text === "")
            return null;
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