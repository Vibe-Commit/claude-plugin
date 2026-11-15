/**
 * The shapes a multi-organization read answers in. `commit_coverage` and `blame_commit` read every organization the caller belongs to, and answer through
 * vibecommit-mcp `src/tools/multi_org.ts` `multiOrg()` (spec A62 (b)):
 *   - exactly one organization ANSWERS:  the ordinary body with `org: {id, name}` added;
 *   - several answer:                    `{ org: null, results: [ { org: {id, name}, ...ordinary body } ] }`, Personal first, then by name;
 *   - no organization answers:           the FIRST organization's own body with no `org` key (what a one-organization caller always saw).
 * What counts as "answers" is the tool's rule, not this client's: a `blame_commit` organization answers when it holds a record (turns, a squash resolution or
 * an unreadable edge), and an organization that has only `no_edge` or `cold_start` does not, so those two states never appear inside `results`.
 *
 * A client built before M-a reads only the third shape (the body at the top level), so the first two read as "answer unreadable". This module is the one place
 * that tells the three apart; `report` and `why` parse each organization's BODY with their own parsers, unchanged.
 *
 * @provenance vibecommit-mcp src/tools/multi_org.ts — the three JSON answer shapes of spec A62 (b), retyped as a contract (no implementation)
 *
 * A malformed `results` (not an array, empty, an entry that is not an object, an entry with no usable `org`) is `null`: a document that
 * claims to be a multi-organization answer and is not one is still unreadable, never half-read.
 */
import { terminalSafe } from "../printable.js";
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function labelOf(value) {
    if (!isRecord(value))
        return null;
    const { id, name } = value;
    return typeof id === "string" && id !== "" && typeof name === "string" && name !== "" ? { id, name } : null;
}
function withoutOrg(record) {
    const { org: _org, ...rest } = record;
    return rest;
}
/** Every organization's answer, in the order the server sent them; `null` when the document is not any of the three shapes. */
export function orgAnswers(document) {
    if (!isRecord(document))
        return null;
    if ("results" in document && document.org === null) {
        const results = document.results;
        if (!Array.isArray(results) || results.length === 0)
            return null;
        const out = [];
        for (const entry of results) {
            if (!isRecord(entry))
                return null;
            const org = labelOf(entry.org);
            if (org === null)
                return null;
            out.push({ org, body: withoutOrg(entry) });
        }
        return out;
    }
    // One organization (a body plus `org`), or the legacy body with no `org` at all. A present but unusable `org` (not null, not a label) is
    // ignored for the label and the body is still read: the body parsers decide whether it is a record.
    return [{ org: labelOf(document.org), body: withoutOrg(document) }];
}
/** An organization's name as it may be printed: the server's text through `terminalSafe` (no control, format or bidi character, no newline), trimmed. */
export function printableName(name) {
    return terminalSafe(name).trim();
}
/** How two headings are compared: NFKC (so a width or compatibility variant of a letter is the same letter), trimmed, case-folded. */
function collisionKey(name) {
    return name.normalize("NFKC").trim().toLowerCase();
}
/**
 * The names to print as headings, one per answer, in order; `null` where the answer names no organization. Two headings that are equal after `collisionKey`
 * (two organizations with one name, a team called "Personal" next to the Personal account, or names that differ only by an invisible character) each carry the
 * first 8 characters of their organization id, `{name} ({id8})`, so a reader can tell them apart. `--json` is unaffected: it keeps the raw `org` object.
 */
export function orgHeadings(orgs) {
    const names = orgs.map((o) => (o === null ? null : printableName(o.name)));
    const counts = new Map();
    for (const n of names)
        if (n !== null)
            counts.set(collisionKey(n), (counts.get(collisionKey(n)) ?? 0) + 1);
    return orgs.map((o, i) => {
        const n = names[i];
        if (o === null || n === null || n === undefined)
            return null;
        return (counts.get(collisionKey(n)) ?? 0) > 1 || n === "" ? `${n}${n === "" ? "" : " "}(${o.id.slice(0, 8)})` : n;
    });
}
/**
 * One organization answered under `--json`: the document keeps the server's `org` object, raw (rv-cap127c 1). The single-organization body is rendered by the
 * unchanged `renderPayload`; this adds the `org` key last. A document that is not a one-line JSON object, or an answer with no `org`, is returned as it was.
 */
export function withOrg(text, org) {
    if (org === null)
        return text;
    try {
        const doc = JSON.parse(text);
        if (!isRecord(doc))
            return text;
        return `${JSON.stringify({ ...doc, org })}\n`;
    }
    catch {
        return text;
    }
}
//# sourceMappingURL=org_answers.js.map