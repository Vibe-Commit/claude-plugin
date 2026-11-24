/**
 * Why a stopped sync stopped, as muted lines (capture 0.8.0, "truth fixes" R2-1). `connect` says it under "Capture is on" and `off`
 * says it after "Stopped here …"; both call this, so the words and the layout are one thing.
 *
 *   - a 400 (our own bug; the queue is kept and will be refused again): the status row's wording, "didn't accept · report this";
 *   - a 401 (the credential is no longer accepted): `ERRORS.authFatal` and the channel's `auth` command. capture 0.17.6 (A4, A5; P6 ruling,
 *     P7 FINAL): when the credential the sync sent came from `VIBECOMMIT_TOKEN`, `ERRORS.authFatal` + `REJECTED.fixLabelEnv` over
 *     `unset VIBECOMMIT_TOKEN`, the 0.17.5 env block's own words (`auth` and `connect` cannot replace the variable).
 *
 * ⛔ **HOOK-SAFE ON PURPOSE.** `status.ts` is on the hook's static import graph (status → grants_verb), so `off` — which lives there —
 * cannot import `connect_account.ts` (which holds `pending_revoke`). This module imports only copy, terminal and install-channel
 * helpers, and `credential.ts`'s env reader, which the hook already imports (`hooks/entry.ts`); `connect_account.ts` imports it too.
 */
import { COMMANDS, ERRORS, REJECTED, STATUS } from "../copy/index.js";
import { envCredentialToken } from "../credential.js";
import { authCommandFor } from "../install.js";
import { paint, wrap } from "../term.js";
/**
 * The reason lines for a sync answer that STOPPED the write, or `null` when the kind has no reason line of its own.
 * `rerun` is the command a 401 names: `auth` for every verb that renews (`status`, `off`), `connect` on connect's own path (T10, 4.12).
 */
export function stoppedSyncReason(ctx, result, rerun) {
    if (result.kind === "rejected") {
        return wrap(STATUS.pendingRejectedValue(Math.max(1, result.pendingRejected ?? 0)), 2).map((line) => paint(ctx.colour, "muted", line));
    }
    if (result.kind === "unauthorized") {
        // The sync sent `loadCredential`'s credential (`grants_verb.ts`), which is the variable's whenever this is non-null (`credential.ts`).
        if (envCredentialToken(ctx.env) !== null) {
            return [paint(ctx.colour, "muted", `  ${ERRORS.authFatal} ${REJECTED.fixLabelEnv}`), `    ${paint(ctx.colour, "accent", COMMANDS.unsetToken)}`];
        }
        const fix = rerun ?? authCommandFor(ctx.env, ctx.selfPath);
        return [paint(ctx.colour, "muted", `  ${ERRORS.authFatal}`), `    ${paint(ctx.colour, "accent", fix)}`];
    }
    return null;
}
//# sourceMappingURL=sync_reason.js.map