/**
 * The machine-readable surface of the read verbs — DESIGN.md §13.3, D122 §2.
 *
 * §13.3 is the authority and it says three things this module exists to make
 * true:
 *
 *   1. `--json` **implies the whole no-colour detection order** and emits
 *      **NOTHING BUT** the JSON document on stdout. "Nothing but" is literal:
 *      no banner, no progress line, no prose. `resolveColour` already returns
 *      `false` for `json: true`, so half of this was true before; the other half
 *      is `emitJson` being the ONLY thing a verb writes to stdout under the flag.
 *   2. **Grade words appear in `--json` ONLY.** Prose never prints a bare grade
 *      (claims-audit §R3, D65 §DR4), so this is the one place the three-way
 *      `derived` / `observed` / `declared` distinction is machine-readable.
 *   3. The three status states stay **distinguishable**. §13.2's `GLYPH` rule
 *      ("a dropped glyph turns three distinguishable states into three identical
 *      ones") has no glyph here, and `outcome` carries the distinction instead.
 *
 * ## ⛔ THE RULE THAT GOVERNS EVERY FIELD: A ZERO IS A MEASUREMENT CLAIM
 *
 * `CR-129a`'s title, and it is the single most likely way to get this surface
 * wrong. **`null` means NOT KNOWN. `0` and `[]` mean MEASURED NONE.** They are
 * different facts and this document keeps them different, because the two
 * absences it actually has to express today are both of the first kind:
 *
 *   - `commit_file_attribution` **has no writer** (D104 §2b), so mcp hardcodes
 *     `files: []` on every turn. That is *we do not know which files*, which is
 *     why `turnDocument` renders it as `null` and NEVER as `[]`.
 *   - `observed` **has no producer in any repo** (D104 §2a). So no field here is
 *     ever populated with a grade the wire did not send: `grades` and `by_grade`
 *     are ECHOED, never widened to the full enum with zeros. A key the payload
 *     did not carry stays absent rather than becoming `0`.
 *
 * ⚠ The corollary is that `[]` and `0` are legal in this schema and simply do
 * not occur on the paths that have no producer. That is deliberate: the document
 * must be ABLE to say *none* distinctly from *not known*, or the day a producer
 * lands there is no way to say it.
 *
 * ⚠ **THE WORD `from` IS NEVER FOLLOWED BY A DOUBLE-QUOTED PHRASE IN THIS
 * FILE**, and that is a constraint rather than a style. `test/provenance.test.ts`
 * runs a linkage wall as a REGEX over raw text — `(?:from|import)` then optional
 * space then a quoted specifier — so an ordinary sentence that quotes a phrase
 * right after that word reads as an import escaping the package and turns the
 * wall RED against correct prose. It did, on the first run of this file, and
 * then again on the first wording of this very warning. `src/commands/why.ts`
 * and `src/oauth/signin.ts` already carry the same note; a false RED is the more
 * dangerous direction, because it justifies "fixing" correct content and nothing
 * later flags it. Quote such phrases in *italics* here instead.
 *
 * ## What is NOT here, deliberately
 *
 * **A failure is not an answer to the question asked** — but since 0.7.0 (PR 7) it is no longer silent either. A verb that
 * could not do its job writes ONE failure document (`renderJsonError`: `outcome: "error"`, the stable `code`, the
 * what/why and the fix) to stdout and NOTHING to stderr, with the same exit code as the text block. Before PR 7 it
 * rendered the block to stderr and left stdout empty, and the exit code alone could not tell a wrapper which failure;
 * the stable codes (`src/copy/error_codes.ts`) can, so the parallel vocabulary the older text declined to mint is now
 * the same one. **Absence is not a failure** and DOES emit an ordinary document: `why` on a commit with
 * no edge and `report` on an empty window are ANSWERS (exit 4 says so), and a machine surface that went silent on them
 * would lose the state that matters.
 *
 * ⚠ §13.3 does not settle that split in either direction. It is reported as an
 * open question rather than smoothed over — `DESIGN.md` is orchestrator-owned
 * (D66 §3) and this module's reading of it is a builder's, not a ruling.
 */
/**
 * The document format version, and it is the FIRST key so a wrapper can branch
 * before it parses anything else. Bumped only when a field changes meaning —
 * adding a key is not a bump.
 */
export const JSON_SCHEMA_VERSION = 1;
/**
 * The exact bytes of one document.
 *
 * ⚠ **ONE LINE, NO INDENTATION, ONE TRAILING NEWLINE.** Compact is what makes
 * "nothing before or after the document" checkable on the RAW BYTES rather than
 * by trusting a lenient parser — a leading banner on its own line still parses
 * under most readers, and this shape makes that impossible to miss. §13.4's
 * 80-column rule does not apply: it governs terminal prose, and this is not
 * prose. The trailing newline is the POSIX line-termination convention, not
 * copy; `JSON.parse` ignores trailing whitespace, so it cannot break a consumer.
 */
export function renderJson(verb, outcome, body) {
    return `${JSON.stringify({ schema: JSON_SCHEMA_VERSION, verb, outcome, ...body })}\n`;
}
/**
 * A failure as a document — 0.7.0 PR 7. Under `--json` a verb that could not do its job writes ONE document to stdout
 * and nothing to stderr, with the verb's own exit code:
 *
 * ```
 *   { "schema": 1, "verb": "status", "outcome": "error",
 *     "error": { "code": "NOT_CONNECTED", "what": "…", "why": ["…"],
 *                "fix": { "label": "…", "commands": ["…"] } | null } }
 * ```
 *
 * This REPLACES the 0.6.x contract that a `--json` failure leaves stdout empty (the text above said "a failure is not
 * an answer"; the exit code alone could not tell a wrapper WHICH failure, and the codes can). `fix` is `null` only when
 * the block has no fix label at all (a label with nothing to type is `{ label, commands: [] }`), and its commands are the SAME strings the text block
 * prints, already routed through the install channel.
 */
export function renderJsonError(verb, block) {
    // `fix` is null only when the block has no fix label at all. A label with no command ("Run it again inside a git
    // repository.") is a fix with `commands: []`; it is never a label-less list of commands.
    const fix = block.fixLabel !== undefined ? { label: block.fixLabel, commands: [...(block.fixes ?? [])] } : null;
    return renderJson(verb, "error", {
        error: { code: block.code, what: block.what, why: [...block.why], fix },
    });
}
/** Write the failure document to stdout and nothing else (the caller writes nothing to stderr). */
export function emitJsonError(stdout, verb, block) {
    stdout.write(renderJsonError(verb, block));
}
/**
 * Write one document to stdout, and nothing else.
 *
 * Takes the stream rather than the whole `CommandContext` so the same helper
 * serves all three verbs without importing a command module into a leaf.
 */
export function emitJson(stdout, verb, outcome, body) {
    stdout.write(renderJson(verb, outcome, body));
}
//# sourceMappingURL=json.js.map