import { printableName } from "./oauth/org_answers.js";
import { MAX_ERROR_BODY_BYTES, readCappedJson } from "./post.js";
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from "./version.js";
export const CAPTURE_ROUTE_PATH = "/ingest/v1/capture/route";
export const CAPTURE_ROUTE_TIMEOUT_MS = 3_000;
/** The 13 reasons `route_capture` gives (spec §5.1 item 6). */
export const ROUTE_REASONS = [
    "team",
    "team_unsynced",
    "own_personal",
    "not_member",
    "sharing_off",
    "no_github_access",
    "github_not_confirmed",
    "org_paused",
    "org_deleting",
    "installation_suspended",
    "other_personal_owner",
    "unowned",
    "not_github",
];
function parse(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body))
        return null;
    const o = body;
    if (typeof o.reason !== "string" || !ROUTE_REASONS.includes(o.reason))
        return null;
    const d = o.destination;
    if (d === null || typeof d !== "object" || Array.isArray(d))
        return null;
    const dest = d;
    if (dest.kind !== "personal" && dest.kind !== "team")
        return null;
    // Required fields: the destination's org id and the basis. The destination must agree with the reason (a team reason is a
    // team destination, every other reason is Personal); a contradictory answer is off the contract, never a guessed sentence.
    if (typeof dest.org_id !== "string" || dest.org_id === "")
        return null;
    if (typeof o.basis !== "string" || o.basis === "")
        return null;
    const teamReason = o.reason === "team" || o.reason === "team_unsynced";
    if (teamReason !== (dest.kind === "team"))
        return null;
    const name = dest.org_name;
    if (name !== null && typeof name !== "string")
        return null;
    // H1 (rv-capstep): an organization name is free text a team's creator writes. Every server-supplied name goes through #127's `printableName` (terminalSafe: no control,
    // format or bidi character, no newline) BEFORE it can reach the terminal; a name that is empty afterwards is NO name, so the sentence falls back to "the organization that owns it".
    const safe = (s) => (typeof s === "string" ? printableName(s) || null : null);
    const owner = o.owner;
    let ownerName = null;
    if (owner !== undefined && owner !== null) {
        if (typeof owner !== "object" || Array.isArray(owner))
            return null;
        const oo = owner;
        if (typeof oo.org_id !== "string" || oo.org_id === "")
            return null;
        const n = oo.org_name;
        if (typeof n !== "string")
            return null;
        ownerName = safe(n);
    }
    return { reason: o.reason, destination: dest.kind, orgName: safe(name), ownerName };
}
export async function fetchCaptureRoute(ingestUrl, credential, slug, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CAPTURE_ROUTE_TIMEOUT_MS);
    try {
        const url = new URL(CAPTURE_ROUTE_PATH, ingestUrl);
        url.searchParams.set("repo", slug);
        const res = await deps.fetch(url.toString(), {
            method: "GET",
            headers: {
                authorization: `Bearer ${credential.expose()}`,
                accept: "application/json",
                [CLIENT_VERSION_HEADER.toLowerCase()]: CLIENT_VERSION,
            },
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status === 401)
            return { kind: "unauthorized" };
        if (res.status !== 200)
            return { kind: "unavailable" };
        const route = parse(await readCappedJson(res, controller.signal, MAX_ERROR_BODY_BYTES));
        return route === null ? { kind: "unavailable" } : { kind: "ok", ...route };
    }
    catch {
        return { kind: "unavailable" };
    }
    finally {
        clearTimeout(timer);
        // Every return releases the network work: a stalled non-200 body or an oversize 200 must not outlive the budget.
        controller.abort();
    }
}
//# sourceMappingURL=capture_route.js.map