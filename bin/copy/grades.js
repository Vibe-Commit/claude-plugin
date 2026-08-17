/**
 * Edge grades and the ONE function that renders a commit header.
 *
 * D61 §PS6 (claims audit of `why` / `report`) requires that the qualifier a grade
 * carries is adjacent to the sentence that introduces turns. Adjacency is beyond
 * grep, so it is enforced STRUCTURALLY instead: exactly one function renders a
 * commit header, it takes the grade, and no other code path renders one. A
 * table-driven test with one row per grade (and a failing blank cell) holds the
 * line — see `test/copy-grades.test.ts`.
 *
 * Do not add a second header renderer. Do not inline a header string in a
 * command body. Both defeat the mechanism.
 *
 * ⚠ `renderCommitIdentity` is NOT a second one — see its own note. It renders
 * §R3's identity line and CANNOT render an evidence sentence, because it takes
 * no grade. That is the point: the absence screens must be able to say which
 * commit they hold no record for, without acquiring a way to claim evidence.
 */
/**
 * Confidence ordering, weakest first. Used to compute the floor on a
 * mixed-grade commit — D61 §PS6: "On a mixed-grade commit the header takes the
 * floor." The weakest grade present governs the whole header, because a header
 * that reported the strongest grade would describe evidence we do not hold for
 * every edge on that commit.
 */
const GRADE_RANK = ["declared", "observed", "derived"];
/**
 * The floor of a mixed-grade commit: the weakest grade present.
 * Throws on an empty set — a commit with no edges has no header to render, and
 * silently defaulting to the strongest grade is exactly the failure this guards.
 */
export function gradeFloor(grades) {
    if (grades.length === 0) {
        throw new Error("gradeFloor: no edges — a commit with no edge has no header");
    }
    let floor = "derived";
    for (const g of grades) {
        if (GRADE_RANK.indexOf(g) < GRADE_RANK.indexOf(floor))
            floor = g;
    }
    return floor;
}
const GRADE_COPY = {
    derived: {
        qualifier: "The commit command is recorded in this session's transcript.",
    },
    observed: {
        // ⚠ TWO SENTENCES, AND THE FIRST ONE WAS MISSING. D61 §PS6 makes the second
        // mandatory — `observed` also covers a human committing in a second
        // terminal — but the first is the one that says what `observed` MEANS, and
        // §R3 approves both.
        qualifier: "This commit appeared while the session was running. The commit command was not in the transcript, so it may include work from outside this session.",
    },
    declared: {
        qualifier: "The agent reported this commit. It is not in the transcript record.",
    },
};
/**
 * §R3 row 1. The `→` and `·` are U+2192 and U+00B7 — one column, several bytes
 * each, which is why every width check in this package counts COLUMNS.
 */
function identityLine(commit) {
    return `Line ${commit.line} → ${commit.sha} · ${commit.date} (git blame)`;
}
/**
 * THE header renderer. One function, takes the grade, no other path renders a
 * commit header — and it now returns §R3's TWO LINES rather than one, because
 * the identity line and the evidence sentence are one unit: rendering either
 * without the other is what the structural rule exists to prevent.
 *
 * @param grades every edge grade held for the commit. The floor governs.
 */
export function renderCommitHeader(grades, commit) {
    return [identityLine(commit), GRADE_COPY[gradeFloor(grades)].qualifier];
}
/**
 * The identity line ALONE — for the screens that hold no edge and therefore
 * have no grade to render beside it (cold start, no-edge, squash-resolved,
 * and every read-lane failure).
 *
 * ⚠ This is NOT a second header renderer and must not become one: it takes no
 * grade and it cannot produce an evidence sentence. The rule it protects is the
 * inverse of the one `renderCommitHeader` protects — a screen may not claim
 * evidence without a grade, and `gradeFloor` throws on an empty set, so without
 * this the absence screens would have no way to say WHICH commit they are
 * silent about. §10.6 draws the identity line on states A and E.
 */
export function renderCommitIdentity(commit) {
    return identityLine(commit);
}
/** Exposed for the table-driven test; not for command bodies. */
export function gradeCopyFor(grade) {
    return GRADE_COPY[grade];
}
export const ALL_GRADES = ["derived", "observed", "declared"];
//# sourceMappingURL=grades.js.map