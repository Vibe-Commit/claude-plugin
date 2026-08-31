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
 *
 * MATCH SEMANTICS (D113 §2, register §"Match semantics"): a phrase matches at a
 * LEADING WORD BOUNDARY and NOT a trailing one — `\b` before, nothing after.
 *
 *   - The LEADING boundary is what makes `proves` registerable at all. Under a
 *     bare substring rule it fires on the shipped, D81-approved disclosure
 *     "...once an owner approves." (`strings.ts` `CONNECT.pendingBuffered`) —
 *     measured, not argued: adding the row to a `.includes()` matcher turns
 *     `copy-claims.test.ts`'s "no shipped copy contains a phrase blocked on its
 *     surface" RED against correct copy. A boundary kills that by construction;
 *     an EXEMPT row would have to be re-added every time the sentence is
 *     reworded.
 *   - There is deliberately NO TRAILING boundary. The register depends on ROOTS:
 *     `attest` must go on matching `attested` and `attestation`, and the bare
 *     `signed receipt` must go on matching `signed receipts`. Anchoring both
 *     ends would silently narrow those rows to close one.
 *
 * The rule is strictly NARROWING against the substring rule it replaced, so it
 * can only ever remove matches. WHAT FALSIFIES IT: `findClaimViolations`
 * reporting a hit whose match begins mid-word. The executable statement of that
 * is `copy-claims.test.ts` — the `approves` and `cannot aim` negatives, and the
 * root-matching positives for `attest*` and `signed receipt(s)`. If the matcher
 * ever reverts to `.includes()`, those negatives go RED; if the leading `\b`
 * grows a trailing one, the root positives go RED. Neither can rot silently.
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
    // --- CR-132d (D113 §4, D123 §1): the rows the register carries and this
    //     projection did not. Derived by EVALUATING this array against the
    //     register's machine-readable block under the block's own leading-`\b`
    //     rule — never by comparing the two lists by eye, which is how the
    //     singular/plural `signed receipt` gap survived an author pass (D101:
    //     write the predicate, never the tally).
    //
    //     ⚠ TWO OF THESE PREFIX-SUPERSEDE ROWS ABOVE, and that is the point of
    //     omitting the trailing boundary. `signed receipt` (singular) matches
    //     inside `signed receipts`, and bare `prompt produced` matches inside
    //     `see what prompt produced a given line`. The long forms are KEPT, not
    //     deleted: their `reason` fields carry register history the short rows
    //     cannot ("D51 dropped submission_receipts"; the four-pattern-regex
    //     miss), and this task is additive-only so a reviewer can see that no
    //     live protection was traded away. They are now redundant, not wrong.
    {
        phrase: "proves",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Register: same proposition as `provable`, no banned root — the form a rewrite reaches for.",
        gate: "attestation witness GA",
    },
    {
        phrase: "signed receipt",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Register: claims a component DELETED by D51. Singular, so it also binds the plural above.",
        gate: "Never lifts unless something is actually signed.",
    },
    {
        phrase: "signed bundle",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Register: same as `signed receipt` — the export is a hash-chain bundle, unsigned.",
        gate: "Never lifts unless something is actually signed.",
    },
    {
        phrase: "prompt produced",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Register: concept blocked, no banned word appears. Bare form — a reworded paraphrase walks past the long row above (D113 §4).",
        gate: "NEVER LIFTS — file-scoped by design (D61 §PS6).",
    },
    {
        phrase: "source-available",
        surfaces: ["why", "report", "help", "status", "connect", "off"],
        reason: "Register: licensing REVERSED by D60/D1 — the phrase is retired and was never a description of us.",
        gate: "NEVER LIFTS — the term is retired, not gated.",
    },
    // --- ⛔ THE `observed` FAMILY. THE GATE BELOW HAS FIRED AND THE ROWS DO NOT
    //     LIFT. Register changelog 2026-08-21 (W20, D183/D184/D185).
    //
    //     These three carried *"the producer is ABSENT, not immature"* and *"None
    //     exists (D111 §2)"* until W20, and BOTH became false when `CR-170` shipped
    //     `observe()` in `src/hooks/post_commit.ts` — false metadata sitting on copy
    //     that ships. This is the correction, and it is a correction of the REASON,
    //     never of the verdict.
    //
    //     ⛔ THE GROUND CHANGED SPECIES; IT DID NOT GO AWAY. It was a
    //     signed-receipts claim — copy describing a component that is not there —
    //     and it is now an ordinary OVERCLAIM: a real component, described past its
    //     reach. The producer observes THE COMMIT EVENT and never THE AUTHORSHIP;
    //     these three are scoped to `why`, the one surface that answers who wrote a
    //     line, so on THAT surface they still assert what no mechanism produces.
    //
    //     ⛔ A READER WHO FINDS THE GATE FIRED AND LIFTS THESE HAS READ THE GATE AND
    //     NOT THE CLAIM. The register says so in those words. `env_session_id` — the
    //     strongest rung the ladder can reach — is SAFE as command provenance and
    //     STILL BLOCKED as authorship, because `git commit -a` commits a human's
    //     working-tree edits identically.
    //
    //     ⚠ `phrase` and `surfaces` are DELIBERATELY UNCHANGED. `test/copy-claims.test.ts:318`
    //     pins this projection against a hand-written list, and the register's block
    //     is hand-synced across repos — a phrase edit here breaks a projection that
    //     has no compiler.
    {
        phrase: "seen during the session",
        surfaces: ["why"],
        reason: "Register: the post-commit hook sees the COMMIT EVENT, never who wrote the line; on `why` this claims the second.",
        gate: "A mechanism that establishes AUTHORSHIP. ⛔ NOT the producer gate — that one FIRED (CR-170) and these rows stayed.",
    },
    {
        phrase: "we observed",
        surfaces: ["why"],
        reason: "Register: the same claim in the first person; the form a rewrite reaches for.",
        gate: "A mechanism that establishes AUTHORSHIP. ⛔ NOT the producer gate — that one FIRED (CR-170) and these rows stayed.",
    },
    {
        phrase: "watched",
        surfaces: ["why"],
        reason: "Register: same proposition, no registered root — and `watched` adds a continuity nothing does.",
        gate: "A mechanism that establishes AUTHORSHIP. ⛔ NOT the producer gate — that one FIRED (CR-170) and these rows stayed.",
    },
    {
        phrase: "not agent-authored",
        surfaces: ["why", "report", "help", "status"],
        reason: "Register: the 4th member of the absence-inversion row — an uncaptured session leaves no edge. Prose-only in BOTH directions until now.",
        gate: "BLOCKED PERMANENTLY.",
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
/** Escape a phrase for literal use in a RegExp — rows carry `-` today and could carry `.` or `+`. */
function escapeForRegExp(literal) {
    return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const MATCHERS = new Map();
/**
 * The compiled form of one row: `\b` before the phrase, nothing after.
 *
 * ⚠ NO `g` FLAG, deliberately. A global RegExp carries `lastIndex` across
 * `.test()` calls, so a cached one would alternate true/false on the same
 * input — a gate that fires on every other string, which reads as flake.
 */
function matcherFor(phrase) {
    let matcher = MATCHERS.get(phrase);
    if (matcher === undefined) {
        matcher = new RegExp(`\\b${escapeForRegExp(phrase)}`, "i");
        MATCHERS.set(phrase, matcher);
    }
    return matcher;
}
/**
 * Scan one rendered string for phrases blocked on its surface.
 *
 * Matching is leading-word-boundary, case-insensitive, no trailing boundary —
 * see MATCH SEMANTICS in the file header for why each half of that is load-
 * bearing.
 *
 * A clean result means "no known banned phrase found" — never "claims clean".
 * Report it that way; anything stronger reports the strength of the wordlist
 * rather than the state of the copy.
 */
export function findClaimViolations(text, surface) {
    const out = [];
    for (const entry of BLOCKED_PHRASES) {
        if (!entry.surfaces.includes(surface))
            continue;
        if (matcherFor(entry.phrase).test(text)) {
            out.push({ phrase: entry.phrase, surface, reason: entry.reason, gate: entry.gate });
        }
    }
    return out;
}
//# sourceMappingURL=claims.js.map