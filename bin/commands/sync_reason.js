/**
 * Why a stopped sync stopped, as muted lines (capture 0.8.0, "truth fixes" R2-1). `connect` says it under "Capture is on" and `off`
 * says it after "Stopped here …"; both call this, so the words and the layout are one thing.
 *
 *   - a 400 (our own bug; the queue is kept and will be refused again): the status row's wording, "didn't accept · report this";
 *   - a 401 (the credential is no longer accepted): `ERRORS.authFatal` and the channel's `auth` command.
 *
 * ⛔ **HOOK-SAFE ON PURPOSE.** `status.ts` is on the hook's static import graph (status → grants_verb), so `off` — which lives there —
 * cannot import `connect_account.ts` (which holds `pending_revoke`). This module imports only copy, terminal and install-channel
 * helpers; `connect_account.ts` imports it too.
 */
import { ERRORS, STATUS } from "../copy/index.js";
import { authCommandFor } from "../install.js";
import { paint, wrap } from "../term.js";
/** The reason lines for a sync answer that STOPPED the write, or `null` when the kind has no reason line of its own. */
export function stoppedSyncReason(ctx, result) {
    if (result.kind === "rejected") {
        return wrap(STATUS.pendingRejectedValue(Math.max(1, result.pendingRejected ?? 0)), 2).map((line) => paint(ctx.colour, "muted", line));
    }
    if (result.kind === "unauthorized") {
        return [paint(ctx.colour, "muted", `  ${ERRORS.authFatal}`), `    ${paint(ctx.colour, "accent", authCommandFor(ctx.env, ctx.selfPath))}`];
    }
    return null;
}
//# sourceMappingURL=sync_reason.js.map