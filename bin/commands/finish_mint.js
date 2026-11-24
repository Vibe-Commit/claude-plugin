/** The one question (default No). It names no organization (T41c, §4.7); on the picker path it names the repos chosen, not the machine (0.7.0, D7 · 3A). */
function workspaceQuestion(scope) {
    return scope === "repos" ? REPLACE.questionRepos : REPLACE.question;
}
/**
 * Everything between "the server minted a credential" and "this machine has it" — `finishMint` — and the
 * result type both browser beats return. Shared by the loopback flow (`browser_credential.ts`) and the
 * device flow (`device_credential.ts`, `CR-234d`), and living in neither so that the two can import it
 * without importing each other.
 */
import { isAffirmative } from "../consent.js";
import { authCommandFor } from "../install.js";
import { CONNECT, REPLACE, RETIRE, AUTH } from "../copy/index.js";
import { loadedFingerprints, metaFor, recordCredentialMeta } from "../credential_meta.js";
import { saveCredential } from "../credential.js";
import { REVOKE_TIMEOUT_MS, retireCredential, selfRevokeCredential, selfRevokeOutcome } from "../oauth/retire.js";
import { terminalSafe } from "../printable.js";
import { credentialFingerprint } from "../post.js";
import { paint, labelled, renderErrorBlock, truncateMiddle, wrap, WRAP_COLUMNS, LABEL_GUTTER } from "../term.js";
import { writeLines } from "./context.js";
import { probeCredential } from "./probe.js";
/**
 * 0.17.1 (P7 ruling, 2026-11-22): a mint failure's why is its outcome's base sentence plus a tail. 0.17.4 (P7 FINAL): the tail is "No
 * credential was saved." on every path. 0.17.2 still gave `auth --device` "Nothing was written.", which the verb-start revoke retry
 * (cli.ts) falsifies: it can rewrite or delete pending-revoke.json before any verb runs. One base sentence per outcome; no duplicated keys.
 */
export function withMintTail(base) {
    return `${base} ${AUTH.connectTail}`;
}
/**
 * 0.17.1 (P7 ruling, 2026-11-22): the same shape for a failed sign-in (`signInError`) and a failed device sign-in. 0.17.4 (P7 FINAL): the
 * tail is "No credential was saved." on every path; `auth`'s "Nothing was changed on this machine." was false after the verb-start revoke
 * retry. A `null` base (DEVICE's denied and refused) is the tail alone. connect's `--sign-in` beat keeps its own tail (browser_credential.ts).
 */
export function withSignInTail(base) {
    return base === null ? AUTH.connectTail : `${base} ${AUTH.connectTail}`;
}
/**
 * 0.17.1 (P7 ruling): the saved-choices line a failed sign-in or mint on connect's path adds, with the SAME gate as `signInError`'s
 * (browser_credential.ts): connect's path, once grants were written. Empty for `auth` and before any grant, so those stay as they were.
 */
export function savedChoicesLines(connectPath) {
    return connectPath?.grantsWritten === true ? [AUTH.savedChoicesWhy] : [];
}
/**
 * The code for a failed mint. Eight reasons share `MINT_FAILED`; two are split off because the action differs (join or
 * ask the workspace owner; wait until the stated time) — VQ's Q3. 0.17.5 item 5a: moved here from `browser_credential.ts` so the device
 * flow uses it too (it named a membership refusal MINT_FAILED on `auth --device`).
 */
export function mintCode(outcome) {
    if (outcome.kind === "refused" && outcome.error === "not_a_member")
        return "MINT_NOT_A_MEMBER";
    if (outcome.kind === "refused" && outcome.error === "rate_limited")
        return "MINT_RATE_LIMITED";
    return "MINT_FAILED";
}
/**
 * T10 (B5, DX-7): `connect`'s recovery line for the mint failures that have one (rate limited, not a member, unreachable). Only
 * `connect` passes a `connectPath`. For every other caller, and for the failures this does not name, the caller prints its own block,
 * byte-identical to today's. The rate-limit line uses the server's `Retry-After` when the mint answer carries one (prc1 S9(c)), else the
 * plan's "up to an hour". The not-a-member line names no account: the server's refusal carries none. `what` is the path's (0.17.5
 * item 5a, P7 FINAL): `AUTH.mintFailedWhat` on the browser path, `AUTH.mintFailedWhatDevice` on the device path.
 */
export function connectMintBlock(outcome, connectPath, endpoint, now, what) {
    if (outcome.kind === "refused" && outcome.error === "rate_limited") {
        // prc1 S9(c): the server's own retry time when it sent one (a clock reading, local time), else the plan's fallback.
        const wait = outcome.retryAfterS === undefined
            ? AUTH.rateLimitedWait
            : AUTH.rateLimitedAt(clockReading(new Date(now.getTime() + outcome.retryAfterS * 1000)));
        return {
            kind: "bad",
            code: "MINT_RATE_LIMITED",
            what,
            // connect's path always wrote the grants and hooks first, so the tail is connect's whatever the flow.
            why: [withMintTail(AUTH.mintRateLimitedWhy), wait, ...savedChoicesLines(connectPath)],
            fixLabel: AUTH.rateLimitedAgain,
            fixes: [connectPath.rerun],
        };
    }
    if (outcome.kind === "refused" && outcome.error === "not_a_member") {
        return {
            kind: "bad",
            code: "MINT_NOT_A_MEMBER",
            what,
            why: [withMintTail(AUTH.mintNotMemberWhy), ...savedChoicesLines(connectPath)],
            fixLabel: AUTH.notMemberFix,
        };
    }
    if (outcome.kind === "unreachable" || (outcome.kind === "refused" && outcome.status >= 500)) {
        return {
            kind: "bad",
            code: "MINT_FAILED",
            what,
            // A 5xx is an ANSWER (the service refused), so it keeps `auth`'s refused sentence; only no answer at all is "did not answer" (T20
            // sweep, CL-C F4). The recovery line is DX-7's for both: retry once, then the network.
            why: [
                withMintTail(outcome.kind === "unreachable" ? AUTH.mintUnreachableWhy : AUTH.mintRefusedWhy),
                AUTH.unreachableTried(terminalSafe(new URL(endpoint).host)),
                ...savedChoicesLines(connectPath),
            ],
            fixLabel: AUTH.unreachableFix,
            fixes: [connectPath.rerun],
        };
    }
    return null;
}
/** `14:32`, local time, 24-hour: an absolute clock reading, never "in 5 minutes" (the waiting block's convention, device_credential.ts). */
function clockReading(date) {
    const two = (n) => String(n).padStart(2, "0");
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
/** `connect`'s write-ahead row, handed to `finishMint` only when set (exactOptionalPropertyTypes). */
export function writeAheadOf(connectPath) {
    return connectPath?.writeAhead === undefined ? {} : { writeAhead: connectPath.writeAhead };
}
/** The row a credential was written under goes once the credential is revoked cleanly, by the hold (`g`) or the write-ahead (connect). */
function releaseRow(input, minted) {
    input.hold?.release(minted);
    input.writeAhead?.release(minted);
}
/** GitHub's own limit on a handle. A longer one is cut in the middle (§13.4), so no row passes 80 columns. */
const HANDLE_MAX = 39;
/**
 * ENG-15 (T10; placement settled with P6, the words are DRAFT for P7). On `connect`'s replace, the first line of the confirmation
 * names the handle this machine was signed in as and the one just signed in. One warn block. Nothing is printed when the old handle
 * is unknown, or when both are known and equal (case-insensitive). Handles only, never an organization (T41c).
 */
function replacedWarnLines(ctx, was, now) {
    if (was === null)
        return [];
    if (now !== null && now.toLowerCase() === was.toLowerCase())
        return [];
    const old = `@${truncateMiddle(terminalSafe(was), HANDLE_MAX)}`;
    const what = now === null
        ? REPLACE.replacedUnknown(old)
        : REPLACE.replacedOther(old, `@${truncateMiddle(terminalSafe(now), HANDLE_MAX)}`);
    return renderErrorBlock({ kind: "warn", what, why: [] }, ctx.colour);
}
/**
 * Everything between "the server minted a credential" and "this machine has it" — shared by the
 * loopback flow now and the device flow in slice 2 (eng review D1 = B, the smaller arrangement).
 *
 *   1. probe the NEW credential (whoami) — a credential the server then refuses is never saved
 *   2. the confirmation block, when it is called for — ONE question, default NO
 *   3. N: save nothing, leave the old file byte-identical (see `REPLACE.declinedOrphan`)
 *   4. y: atomic save → sidecar → retire the old credential
 *
 * ⛔ THE ORDER IS THE SAFETY. Retire is last because a retired old credential plus a failed save would
 * leave the machine with nothing; it is attempted only when the old one came from the FILE (a null
 * `prior` is every env case), only when the old one is not already known dead, and never when the
 * two credentials are known to be in different workspaces ("re-auth across orgs retires nothing and
 * says so").
 */
export async function finishMint(ctx, input) {
    const { minted, facts, prior } = input;
    // ⛔ WRITE-AHEAD (`g`): the row exists before the probe, the question, or anything that can be interrupted. If it cannot be
    // written, nothing may keep this credential alive that the client does not remember: revoke it now, in memory.
    if (input.hold !== undefined && !input.hold.record(minted, input.endpoint)) {
        const revoked = await selfRevokeOutcome(input.endpoint, minted, { fetch: input.fetch, timeoutMs: REVOKE_TIMEOUT_MS });
        // A 404 (`unknown`) is a server with no revoke route: the credential may still be live, so it is NOT "revoked" ("0.8.0 truth fixes" F7).
        return { kind: "unrecorded", revoked: revoked.kind === "retired" || revoked.kind === "gone" };
    }
    // ⛔ WRITE-AHEAD (T10 B3): the row exists before the probe and before the question. If it cannot be written, revoke in memory and
    // return `unrecorded`, as `hold` does: the caller prints it (`printUnrecorded`) and exits. Nothing is kept.
    if (input.writeAhead !== undefined && !input.writeAhead.record(minted, input.endpoint)) {
        const revoked = await selfRevokeOutcome(input.endpoint, minted, { fetch: input.fetch, timeoutMs: REVOKE_TIMEOUT_MS });
        return { kind: "unrecorded", revoked: revoked.kind === "retired" || revoked.kind === "gone" };
    }
    const fresh = await probeCredential(ctx, minted, input.fetch, { record: false });
    if (fresh.kind === "unauthorized") {
        writeLines(ctx.stderr, [
            "",
            ...renderErrorBlock({
                kind: "bad",
                code: "MINT_FAILED",
                // 0.17.5 (P7 FINAL): the service DID create this credential; the probe of it was refused. Both paths.
                what: AUTH.mintUnconfirmedWhat,
                why: [withMintTail(AUTH.mintUnconfirmedWhy), ...savedChoicesLines(input.connectPath)],
            }, ctx.colour),
        ]);
        return { kind: "failed" };
    }
    const priorOk = prior !== null && prior.who.kind === "ok";
    const crossOrg = priorOk && fresh.kind === "ok" && prior.who.orgId !== fresh.orgId;
    // ⛔ NEVER SAVE WITHOUT THE QUESTION BECAUSE A PROBE FAILED (A4 §3). "A re-auth never silently moves
    // capture between orgs" and the confirmation is the reverse-attack control, so an unanswered probe
    // of the NEW credential cannot be a way past it:
    //   - on-replace, the old credential was confirmed but the new one was not: the workspace match
    //     cannot be shown, so ask — without naming a workspace;
    //   - always (the device flow): never save unasked. Show the ticket's own account/workspace when the
    //     probe failed; if there is none of that either, FAIL CLOSED.
    // No prior (or an env credential) means nothing to move from, so an unanswered probe still saves.
    const unconfirmed = fresh.kind !== "ok";
    const askUnnamed = input.confirm === "on-replace" && priorOk && unconfirmed;
    // What the confirmation shows. The probe's answer, else (A4 §3) the ticket's own account and workspace, else the mint's facts. P6
    // (prc1 S2) withdrew ENG-15's ticket→facts fallback: on connect's path the question is reached only with a fresh ok probe.
    const shown = fresh.kind === "ok"
        ? { account: fresh.account, orgName: fresh.orgName }
        : input.confirm === "always"
            ? { account: input.ticket?.account ?? null, orgName: input.ticket?.orgName ?? null }
            : { account: facts.account, orgName: null };
    // ENG-15: the handle this machine's sidecar names for the credential being replaced. `prior` is FILE-only (`browser_credential.ts`),
    // so an environment credential, which is never `prior`, has none and prints no line.
    const replacedAccount = input.connectPath?.replacing === true && prior !== null ? (metaFor(ctx.home, credentialFingerprint(prior.credential))?.account ?? null) : null;
    // ⛔ FAIL CLOSED (prc1 S2, plan 4.12 :1113): on connect's REPLACE (the 401 and faulty-file cases) a probe that did not answer saves
    // nothing, the device flow included. connect's first sign-in (no credential) and `auth` keep today's rule: the `shown.orgName == null`
    // exception (A4 §3) for the device flow, and for the loopback the rule that a first sign-in has nothing to move away from.
    if (input.confirm === "always" && unconfirmed && (input.connectPath?.replacing === true || shown?.orgName == null)) {
        const revoked = await selfRevokeCredential(input.endpoint, minted, { fetch: input.fetch });
        if (revoked.kind === "retired")
            releaseRow(input, minted);
        writeLines(ctx.stderr, [
            "",
            ...renderErrorBlock({
                kind: "bad",
                code: "WORKSPACE_UNCONFIRMED",
                what: REPLACE.unconfirmableWhat,
                // 0.17.1 D2 (P7): on connect's path the grants and hooks were written first, so "Nothing was saved" was false there; then the
                // saved-choices line under the same gate (empty off connect's path). 0.17.4 (P7 FINAL): the same words on `auth --device` and the
                // device fallback, where the verb-start revoke retry may have rewritten or deleted pending-revoke.json.
                why: [revoked.kind === "retired" ? REPLACE.unconfirmableWhyRevokedConnect : REPLACE.unconfirmableWhyOrphanConnect, ...savedChoicesLines(input.connectPath)],
                fixLabel: REPLACE.unconfirmableFix,
                fixes: [input.rerun ?? authCommandFor(ctx.env, ctx.selfPath)],
            }, ctx.colour),
        ]);
        return { kind: "failed" };
    }
    if (crossOrg || askUnnamed || input.confirm === "always") {
        // The handle is text this package does not control: cut it in the MIDDLE to what the gutter leaves, so no
        // row passes 80 columns (§13.4). ⛔ T41c (§4.7): NO organization name is printed anywhere in this block (the
        // credential lands in Personal and routing is by repository), neither as a `workspace` row nor on `replaces`.
        const room = WRAP_COLUMNS - 2 - LABEL_GUTTER;
        writeLines(ctx.stdout, [
            "",
            ...replacedWarnLines(ctx, replacedAccount, shown?.account ?? null),
            labelled(2, REPLACE.accountLabel, truncateMiddle(shown?.account == null ? REPLACE.accountUnavailable : `@${terminalSafe(shown.account)}`, room)),
            ...(crossOrg && prior?.who.kind === "ok" ? [labelled(2, REPLACE.replacesLabel, REPLACE.replacesValue)] : []),
            "",
            ...wrap(REPLACE.routing, 2),
        ]);
        // ⛔ A REJECTED QUESTION IS AN N (VQ F1). On a terminal, Ctrl+C at a `readline/promises` question does
        // not raise SIGINT: the interface closes and the promise REJECTS with an AbortError. Left to escape,
        // that skipped the self-revoke below and surfaced as an "unexpected error", leaving the credential
        // just created LIVE and unused in the person's Settings. Any rejection means nobody said yes.
        let answer;
        try {
            answer = await ctx.ask(`  ${workspaceQuestion(input.scope)} ${paint(ctx.colour, "muted", CONNECT.consentAnswers)} `);
        }
        catch {
            answer = null;
        }
        if (answer === null || !isAffirmative(answer)) {
            // N: nothing is saved, and the credential the server just created is unused.
            // Revoke it with itself as the bearer (brief A3) — the two-token retire cannot, because the only
            // credential this machine holds in that workspace is the one to remove. Anything but a clean
            // "retired" leaves it live, and the sentence says where to remove it.
            const revoked = await selfRevokeCredential(input.endpoint, minted, { fetch: input.fetch });
            if (revoked.kind === "retired")
                releaseRow(input, minted);
            // T10 (B5, DX-7): a No after the grants were written is not "the approval is discarded": the choices were saved. Ctrl+C after the
            // grants were written gets the same true line as a No (T20 sweep, CL-C F5). 0.17.1 r1 R1 (P7): on connect's path with NO grant, the
            // hooks may still have been written in this run, so the line says no CREDENTIAL was saved. `auth` keeps 0.17.0's two lines.
            // 0.17.2 (P7): `auth`'s browser path may have written session.json before this question too, so it takes the same two lines.
            // 0.17.4 (P7 FINAL): so does `auth --device`: the verb-start revoke retry may have rewritten or deleted pending-revoke.json.
            const line = input.connectPath?.grantsWritten === true
                ? REPLACE.declinedSavedChoices(input.connectPath.rerun)
                : answer === null
                    ? REPLACE.cancelledConnect
                    : REPLACE.declinedConnect;
            writeLines(ctx.stdout, [
                "",
                ...wrap(line, 2),
                ...wrap(revoked.kind === "retired" ? REPLACE.declinedRevoked : REPLACE.declinedOrphan, 2),
            ]);
            return { kind: "declined" };
        }
    }
    // ⛔ S6 (prc1): a lost hold saves nothing. The lease can run out during a long question, and another verb's retry then settles the
    // row: this is the not-recorded path (`unrecorded`), and the credential is revoked in memory.
    if (input.writeAhead?.holds !== undefined && input.writeAhead.holds(minted) !== "held") {
        const revoked = await selfRevokeOutcome(input.endpoint, minted, { fetch: input.fetch, timeoutMs: REVOKE_TIMEOUT_MS });
        return { kind: "unrecorded", revoked: revoked.kind === "retired" || revoked.kind === "gone" };
    }
    // y — or no question was called for. A held credential (`g`) is NOT written here: the caller writes it after ITS yes.
    if (input.hold === undefined)
        saveCredential(ctx.home, minted);
    // Kept: the row goes only AFTER the save (T10 B3). A save that throws leaves the row, so the credential stays recorded.
    input.writeAhead?.release(minted);
    recordCredentialMeta(ctx.home, credentialFingerprint(minted), {
        expires_at: fresh.kind === "ok" ? fresh.expiresAt ?? facts.expiresAt : facts.expiresAt,
        credential_id: fresh.kind === "ok" ? fresh.credentialId : facts.credentialId,
        org_id: fresh.kind === "ok" ? fresh.orgId : null,
        account: fresh.kind === "ok" ? fresh.account ?? facts.account : facts.account,
        seen_at: ctx.now().toISOString(),
    }, loadedFingerprints(ctx.home, ctx.env));
    const notes = [];
    const envToken = ctx.env.VIBECOMMIT_TOKEN;
    if (envToken !== undefined && envToken.trim() !== "") {
        // D206 §4: the variable still wins, and nothing was retired — `prior` is null for an env credential.
        notes.push(RETIRE.envShadows);
    }
    if (prior !== null && prior.who.kind !== "unauthorized") {
        if (crossOrg) {
            notes.push(RETIRE.notRetired);
        }
        else {
            const retired = await retireCredential(input.endpoint, minted, prior.credential, { fetch: input.fetch });
            notes.push(retired.kind === "retired"
                ? RETIRE.retired
                : retired.kind === "not-retired"
                    ? RETIRE.notRetired
                    : retired.kind === "unknown"
                        ? RETIRE.unknown
                        : RETIRE.failed);
        }
    }
    return input.hold === undefined ? { kind: "saved", credential: minted, notes } : { kind: "held", credential: minted, notes };
}
//# sourceMappingURL=finish_mint.js.map