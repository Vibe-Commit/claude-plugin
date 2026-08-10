/**
 * Machine-readable claims block — CR-090 precondition (2).
 *
 * The lintable unit is a PHRASE scoped to a SURFACE, never a bare word.
 * `docs/claims-register.md` §"Lintable unit" is explicit about why: "verifiable"
 * is SAFE on `/app/audit/export` and BLOCKED everywhere else — one spelling, two
 * statuses, differing only by surface. A word-level gate fires on approved copy
 * on day one and gets disabled by the third false positive.
 *
 * `code/docs/claims-register.md` is the SOURCE. This file is its executable
 * projection for the surfaces this package owns. When the register changes, this
 * changes — never the other way round.
 *
 * HONESTY OF THE GATE: a pass means "no known banned phrase found". It does NOT
 * mean "claims clean". The register records three misses in one file in one day
 * that a four-pattern regex walked straight past, because a claim is a
 * proposition and propositions have no fixed vocabulary.
 */
export const BLOCKED_PHRASES = [
    // --- `why`-as-assertion. Never lifts: file-scoped by design, not by maturity.
    {
        phrase: "why this line exists",
        surfaces: ["why", "help", "report"],
        reason: "Line-level assertion; commit_file_attribution has no line ranges.",
        gate: "NEVER LIFTS — file-scoped by design (D61 §PS6).",
    },
    {
        phrase: "why the agent wrote this",
        surfaces: ["why", "help", "report"],
        reason: "Line-level assertion plus actor attribution.",
        gate: "NEVER LIFTS — file-scoped by design (D61 §PS6).",
    },
    {
        phrase: "the reasoning behind this line",
        surfaces: ["why", "help", "report"],
        reason: "Line-level assertion.",
        gate: "NEVER LIFTS — file-scoped by design (D61 §PS6).",
    },
    {
        phrase: "see what prompt produced a given line",
        surfaces: ["why", "help", "report"],
        reason: "Register row added 2026-08-08: the concept was already blocked and a four-pattern regex still walked past it.",
        gate: "NEVER LIFTS.",
    },
    // --- Attestation-witness-gated vocabulary. BLOCKED on every surface here;
    //     `verifiable` is SAFE only on /app/audit/export, which this package does
    //     not render.
    {
        phrase: "verifiable",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Not independently verifiable to a third party today.",
        gate: "attestation witness GA",
    },
    {
        phrase: "tamper-proof",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Only tamper-EVIDENT today.",
        gate: "attestation witness GA",
    },
    {
        phrase: "immutable",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Immutability is procedural — service_role BYPASSRLS can modify.",
        gate: "Use 'append-only'.",
    },
    {
        phrase: "provable",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Caught 2026-08-08 only because a human read the prose — matches no wordlist built from verifiab|attest|immutable|tamper-proof.",
        gate: "attestation witness GA",
    },
    {
        phrase: "attest",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "No attestation service shipped.",
        gate: "attestation witness GA",
    },
    // --- Durability. Blocked until the metric exists AND renders with its
    //     coverage % and grade mix. See PROVISIONING.md §Gates.
    {
        phrase: "durable",
        surfaces: ["report", "help"],
        reason: "The E2 durability metric is undefined.",
        gate: "metric definition + coverage % + grade mix, all rendering together",
    },
    {
        phrase: "durability",
        surfaces: ["report", "help"],
        reason: "The E2 durability metric is undefined.",
        gate: "metric definition + coverage % + grade mix, all rendering together",
    },
    {
        phrase: "survives",
        surfaces: ["report", "help"],
        reason: "The E2 durability metric is undefined.",
        gate: "metric definition + coverage % + grade mix, all rendering together",
    },
    // --- Permanently blocked: absence of an edge is not absence of an agent.
    {
        phrase: "human-written",
        surfaces: ["why", "report", "help", "status"],
        reason: "An uncaptured session leaves no edge — the sharpest inversion risk in the set.",
        gate: "BLOCKED PERMANENTLY.",
    },
    {
        phrase: "not ai",
        surfaces: ["why", "report", "help", "status"],
        reason: "An uncaptured session leaves no edge.",
        gate: "BLOCKED PERMANENTLY.",
    },
    {
        phrase: "no ai involvement",
        surfaces: ["why", "report", "help", "status"],
        reason: "An uncaptured session leaves no edge.",
        gate: "BLOCKED PERMANENTLY.",
    },
    // --- No human baseline exists in the schema, so no comparison can be made.
    {
        phrase: "ai code quality",
        surfaces: ["report", "help"],
        reason: "Nothing in the schema records a human-authored baseline.",
        gate: "BLOCKED — needs a baseline that does not exist and is not planned.",
    },
    {
        phrase: "wasted spend",
        surfaces: ["report", "help"],
        reason: "Nothing in the schema records a human-authored baseline.",
        gate: "BLOCKED — needs a baseline that does not exist and is not planned.",
    },
    {
        phrase: "signed receipts",
        surfaces: ["why", "report", "help", "connect"],
        reason: "D51 dropped submission_receipts; the export collapsed to a pure hash-chain bundle.",
        gate: "Never lifts unless something is actually signed.",
    },
    // --- D64: this repo is PRIVATE with MIT intact. The licence is the invariant;
    //     the visibility is not. Register row 2026-08-09. Same failure mode as
    //     "signed receipts" — copy describing a mechanism that does not exist,
    //     not an overclaim about strength. `CR-111` owns the replacement.
    {
        phrase: "open source",
        surfaces: ["connect", "help", "status", "off", "why", "report"],
        reason: "Vibe-Commit/vibecommit-capture is PRIVATE (D64). Nobody outside the org can read it.",
        gate: "D64 flipping the repo public.",
    },
    {
        phrase: "open-source",
        surfaces: ["connect", "help", "status", "off", "why", "report"],
        reason: "Vibe-Commit/vibecommit-capture is PRIVATE (D64). Nobody outside the org can read it.",
        gate: "D64 flipping the repo public.",
    },
    {
        phrase: "read the source",
        surfaces: ["connect", "help", "status", "off", "why", "report"],
        reason: "The trust argument D64 falsified. The approved replacement links the public claude-plugin bundle — 'inspect the build' is WEAKER and may not be dressed up as this.",
        gate: "D64 flipping the repo public.",
    },
    {
        phrase: "read the client",
        surfaces: ["connect", "help", "status", "off", "why", "report"],
        reason: "Same row as 'read the source' — the source is not readable outside the org.",
        gate: "D64 flipping the repo public.",
    },
    // --- D65 §DR7: no reassurance adjectives on the consent screen. Not a claims
    //     overclaim in the usual sense — the disclosure's job is to be accurate
    //     about what leaves the machine, and a reassurance sitting next to an
    //     accurate list is what makes the list read as marketing.
    //
    //     D65 §DR7 lists FIVE adjectives; four are registered here. `private` is
    //     deliberately NOT, because the approved disclosure says "File paths
    //     include private-repo paths" — a substring gate on `private` fires on
    //     approved copy on day one, which is the exact failure the register's
    //     §Lintable-unit section says kills a gate by the third false positive.
    //     `private`-as-reassurance stays a human review item.
    ...["secure", "safe", "protected", "encrypted"].map((word) => ({
        phrase: word,
        surfaces: ["connect"],
        reason: "Reassurance adjective on the consent screen (D65 §DR7).",
        gate: "NEVER LIFTS — the disclosure states what is uploaded; it does not reassure.",
    })),
];
/**
 * Scan one rendered string for phrases blocked on its surface.
 *
 * A clean result means "no known banned phrase found" — never "claims clean".
 * Report it that way; anything stronger reports the strength of the wordlist
 * rather than the state of the copy.
 */
export function findClaimViolations(text, surface) {
    const haystack = text.toLowerCase();
    const out = [];
    for (const entry of BLOCKED_PHRASES) {
        if (!entry.surfaces.includes(surface))
            continue;
        if (haystack.includes(entry.phrase.toLowerCase())) {
            out.push({ phrase: entry.phrase, surface, reason: entry.reason, gate: entry.gate });
        }
    }
    return out;
}
//# sourceMappingURL=claims.js.map