/** The one question (default No). On the picker path it names the repos chosen, not the machine (0.7.0, D7 · 3A). */
function workspaceQuestion(scope, orgName) {
    if (scope === "repos") {
        return orgName === null ? REPLACE.questionReposUnconfirmed : REPLACE.questionRepos(truncateMiddle(orgName, 28));
    }
    return orgName === null ? REPLACE.questionUnconfirmed : REPLACE.question(truncateMiddle(orgName, 30));
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
import { loadedFingerprints, recordCredentialMeta } from "../credential_meta.js";
import { saveCredential } from "../credential.js";
import { REVOKE_TIMEOUT_MS, retireCredential, selfRevokeCredential, selfRevokeOutcome } from "../oauth/retire.js";
import { credentialFingerprint } from "../post.js";
import { paint, labelled, renderErrorBlock, truncateMiddle, wrap, WRAP_COLUMNS, LABEL_GUTTER } from "../term.js";
import { writeLines } from "./context.js";
import { probeCredential } from "./probe.js";
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
    const fresh = await probeCredential(ctx, minted, input.fetch, { record: false });
    if (fresh.kind === "unauthorized") {
        writeLines(ctx.stderr, ["", ...renderErrorBlock({ kind: "bad", code: "MINT_FAILED", what: AUTH.mintFailedWhat, why: [AUTH.mintUnconfirmedWhy] }, ctx.colour)]);
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
    const shown = fresh.kind === "ok"
        ? { account: fresh.account, orgName: fresh.orgName }
        : input.confirm === "always"
            ? { account: input.ticket?.account ?? null, orgName: input.ticket?.orgName ?? null }
            : { account: facts.account, orgName: null };
    if (input.confirm === "always" && unconfirmed && shown?.orgName == null) {
        const revoked = await selfRevokeCredential(input.endpoint, minted, { fetch: input.fetch });
        if (revoked.kind === "retired")
            input.hold?.release(minted);
        writeLines(ctx.stderr, [
            "",
            ...renderErrorBlock({
                kind: "bad",
                code: "WORKSPACE_UNCONFIRMED",
                what: REPLACE.unconfirmableWhat,
                why: [revoked.kind === "retired" ? REPLACE.unconfirmableWhyRevoked : REPLACE.unconfirmableWhyOrphan],
                fixLabel: REPLACE.unconfirmableFix,
                fixes: [input.rerun ?? authCommandFor(ctx.env, ctx.selfPath)],
            }, ctx.colour),
        ]);
        return { kind: "failed" };
    }
    if (crossOrg || askUnnamed || input.confirm === "always") {
        // Values are text this package does not control (a workspace name, a handle): cut each in the
        // MIDDLE to what the gutter leaves, so no row passes 80 columns (§13.4).
        const room = WRAP_COLUMNS - 2 - LABEL_GUTTER;
        const orgName = shown?.orgName ?? null;
        writeLines(ctx.stdout, [
            "",
            labelled(2, REPLACE.accountLabel, truncateMiddle(shown?.account == null ? REPLACE.accountUnavailable : `@${shown.account}`, room)),
            labelled(2, REPLACE.workspaceLabel, truncateMiddle(orgName ?? REPLACE.workspaceUnconfirmed, room)),
            ...(crossOrg && prior?.who.kind === "ok"
                ? [labelled(2, REPLACE.replacesLabel, truncateMiddle(REPLACE.replacesValue(prior.who.orgName), room))]
                : []),
        ]);
        // ⛔ A REJECTED QUESTION IS AN N (VQ F1). On a terminal, Ctrl+C at a `readline/promises` question does
        // not raise SIGINT: the interface closes and the promise REJECTS with an AbortError. Left to escape,
        // that skipped the self-revoke below and surfaced as an "unexpected error", leaving the credential
        // just created LIVE and unused in the person's Settings. Any rejection means nobody said yes.
        let answer;
        try {
            answer = await ctx.ask(`  ${workspaceQuestion(input.scope, orgName)} ${paint(ctx.colour, "muted", CONNECT.consentAnswers)} `);
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
                input.hold?.release(minted);
            writeLines(ctx.stdout, [
                "",
                ...wrap(answer === null ? REPLACE.cancelled : REPLACE.declined, 2),
                ...wrap(revoked.kind === "retired" ? REPLACE.declinedRevoked : REPLACE.declinedOrphan, 2),
            ]);
            return { kind: "declined" };
        }
    }
    // y — or no question was called for. A held credential (`g`) is NOT written here: the caller writes it after ITS yes.
    if (input.hold === undefined)
        saveCredential(ctx.home, minted);
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