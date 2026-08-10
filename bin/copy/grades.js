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
        lead: "Conversation turns recorded against the commit that last changed this file.",
        qualifier: "The commit command appears in the recorded transcript.",
    },
    observed: {
        lead: "Conversation turns recorded against the commit that last changed this file.",
        // D61 §PS6 makes this clause mandatory: `observed` also covers a human
        // committing in a second terminal, so timing is all it establishes.
        qualifier: "The commit command was not in the transcript, so it may include work from outside this session.",
    },
    declared: {
        lead: "Conversation turns recorded against the commit that last changed this file.",
        qualifier: "The agent reported this link; it is not corroborated by the transcript.",
    },
};
/**
 * THE header renderer. One function, takes the grade, no other path renders a
 * commit header.
 *
 * @param grades every edge grade held for the commit. The floor governs.
 */
export function renderCommitHeader(grades) {
    const copy = GRADE_COPY[gradeFloor(grades)];
    return `${copy.lead} ${copy.qualifier}`;
}
/** Exposed for the table-driven test; not for command bodies. */
export function gradeCopyFor(grade) {
    return GRADE_COPY[grade];
}
export const ALL_GRADES = ["derived", "observed", "declared"];
//# sourceMappingURL=grades.js.map