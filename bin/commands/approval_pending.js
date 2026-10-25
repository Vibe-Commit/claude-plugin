/**
 * The org-approval-pending block — style guide §10.2's "held" beat, D65 §DR6, D81. One definition for the two places that
 * print it: `connect`, on the 403 its own test capture got, and `status`, for a repo whose last upload got that same 403.
 *
 * ⚠ EXISTING COPY ONLY. `status` adds no sentence of its own; it prints what `connect` prints, so the two cannot drift
 * (`org_pending.ts` records that the 403 happened). The shared clause renders on EVERY branch and `owners_notified` `> 0`
 * ADDS to it (D81); `null` and `0` never claim a notification.
 */
import { CONNECT, URLS } from "../copy/index.js";
import { renderErrorBlock } from "../term.js";
export function approvalPendingBlock(colour, repoSlug, ownersNotified) {
    const why = ownersNotified !== null && ownersNotified > 0
        ? `${CONNECT.pendingRecorded} ${CONNECT.pendingNotified(ownersNotified)}`
        : CONNECT.pendingRecorded;
    return renderErrorBlock({
        kind: "warn",
        what: CONNECT.pendingWhat,
        why: [CONNECT.pendingWhy(repoSlug), why, CONNECT.pendingBuffered],
        fixLabel: CONNECT.pendingTrackLabel,
        fixes: [URLS.captureAccess],
    }, colour);
}
//# sourceMappingURL=approval_pending.js.map