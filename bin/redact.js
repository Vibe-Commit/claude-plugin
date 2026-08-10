/**
 * Out-of-tree redaction — `CR-024d`, D57 §OV8d.
 *
 * A Claude Code transcript records structured file reads and writes VERBATIM:
 * a `Read`, `Edit` or `Write` record carries a path and the file's content. When
 * that path is outside the repository the user consented to, the content of a
 * THIRD PARTY'S file is about to be uploaded under the user's credential and
 * attached to a repo that has nothing to do with it. That is a confidentiality
 * boundary, not a tidiness issue, and it is the whole reason this module exists.
 *
 * ## Why the client, permanently
 *
 * D57 §OV8d: *"Out-of-tree redaction is client-side. Server-side redaction would
 * break `turn_hash == sha256(content)`, so it cannot live on the server at
 * all."* A server that rewrote content after hashing would hold a hash chain
 * over bytes it no longer has. There is no server-side variant to fall back on.
 *
 * ## The deviation this is allowed to make, and its limit
 *
 * D60 §D6 says the client holds no ANALYSIS, and OV8d is the ONE recorded
 * deviation from it, because redacting requires parsing each line. The rule that
 * survives is *"the client may render; it may not analyze, hash, or
 * canonicalize."* So this module parses a line, finds a path, compares it to the
 * project root, and replaces a span. It extracts no turns, computes no digest,
 * canonicalises no record, and imports nothing from `vibecommit-mcp` — that last
 * one is a LICENSING violation, not a style one (D60 §D1a, D64).
 *
 * ## ⚠ LENGTH PRESERVATION IS THE LOAD-BEARING PROPERTY
 *
 * The client sends a raw byte span with `X-Byte-Offset: from`, and the server
 * advances its watermark by the DECOMPRESSED body's length
 * (`vibecommit-mcp/src/conversation/ingest_session.ts`). The client's own
 * `sentOffset` advances to `to`. If a redaction makes the body SHORTER, the two
 * watermarks diverge and every subsequent delta arrives flagged `gap: true`,
 * forever; longer, and every delta is `overlap: true`. A permanently
 * gap-flagged stream is a capture-health surface reporting data loss that is
 * not happening.
 *
 * So every replacement is padded to the exact byte length it replaced, and a
 * span too short to hold even the shortest honest marker is LEFT ALONE. That
 * trade — leak a sub-13-byte span rather than break the accounting — is the
 * brief's, stated rather than smuggled, and `redactSpan` counts what it skipped
 * so the number is reportable.
 *
 * ## Why re-serialising is safe here, measured rather than assumed
 *
 * `JSON.parse` → `JSON.stringify` was byte-identical on **39,910 of 39,910**
 * real transcript lines across 25 sessions, because the transcript is written by
 * `JSON.stringify` in the first place. That is what makes the padding
 * arithmetic exact instead of approximate. It is not taken on faith: every line
 * is round-tripped and compared BEFORE anything is changed, and a line that does
 * not round-trip is returned untouched.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — offset accounting, read
 */
import { Buffer } from "node:buffer";
import { REDACTION } from "./copy/index.js";
import { isInside } from "./paths.js";
/**
 * Keys whose STRING value is a filesystem path naming the record's subject.
 *
 * `notebook_path` is here because `NotebookEdit` names its file that way and
 * carries the cell source alongside — a shape that does NOT appear in the
 * 59,464-line corpus this module was measured against, and was therefore found
 * by attacking the rule rather than by observing traffic. Absence from a corpus
 * is not absence from the product.
 */
const PATH_KEYS = new Set(["file_path", "filePath", "notebook_path", "notebookPath"]);
/**
 * Keys whose value is file CONTENT, redacted when a sibling path is out of tree.
 *
 * Measured against 59,464 real transcript lines rather than assumed, and the
 * measurement is why this list is longer than "the file's content":
 *
 *   content       Read results (`toolUseResult.file.content`), Write inputs
 *   originalFile  the WHOLE pre-edit file, on every Edit result — 2,017 of them
 *                 in the sample, the largest single carrier by volume
 *   oldString/newString, old_string/new_string
 *                 Edit inputs and results, both sides of the change
 *
 * `structuredPatch` is handled separately below: it is an array of hunks whose
 * `lines` are file content too.
 */
const CONTENT_KEYS = new Set([
    "content",
    "originalFile",
    "oldString",
    "newString",
    "old_string",
    "new_string",
    // NotebookEdit's cell bodies. Same provenance as `notebook_path` above.
    "new_source",
    "old_source",
    "newSource",
    "oldSource",
]);
/** Hunk arrays whose `lines` carry file content. */
const PATCH_KEY = "structuredPatch";
const NONE = { redacted: 0, skipped: 0 };
/**
 * Redact one NDJSON line. **Pure, total, and length-preserving.**
 *
 * Returns the line UNCHANGED on anything it cannot handle — a blank line, a
 * parse failure, a line that does not round-trip. A hook cannot report an error
 * (DESIGN.md §13.7), and a redactor that dropped a line it could not parse would
 * be silent data loss on a path where D56 §D8 makes loss permanent.
 */
export function redactLine(line, projectRoot, resolver = containment()) {
    if (line === "")
        return { line, ...NONE };
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        // A partial line at a span boundary lands here, and so does anything else
        // that is not JSON. Unchanged is the only honest answer.
        return { line, ...NONE };
    }
    // The round-trip gate. Padding arithmetic is only exact if everything this
    // module does NOT touch re-serialises to the same bytes.
    let baseline;
    try {
        baseline = JSON.stringify(parsed);
    }
    catch {
        return { line, ...NONE };
    }
    if (baseline !== line)
        return { line, ...NONE };
    const counts = { redacted: 0, skipped: 0 };
    walk(parsed, projectRoot, resolver, counts);
    if (counts.redacted === 0)
        return { line, ...counts };
    let out;
    try {
        out = JSON.stringify(parsed);
    }
    catch {
        return { line, ...NONE };
    }
    // The backstop. Per-field arithmetic should make this exact; if it ever is
    // not, the accounting matters more than the redaction (see the header) and
    // the caller gets the original bytes plus an honest skip count.
    if (Buffer.byteLength(out) !== Buffer.byteLength(line)) {
        return { line, redacted: 0, skipped: counts.redacted + counts.skipped };
    }
    return { line: out, ...counts };
}
/**
 * Redact every complete line in a raw transcript span.
 *
 * Operates on BYTES because a span is a byte range and its edges need not fall
 * on a line — or even on a character. Segments are split on `\n` and a segment
 * that does not decode to exactly its own bytes is passed through untouched,
 * which is what keeps a span that bisects a multi-byte character from changing
 * length when it is re-encoded.
 */
export function redactSpan(span, projectRoot) {
    const resolver = containment();
    const counts = { redacted: 0, skipped: 0 };
    const NEWLINE = 0x0a;
    const out = [];
    let start = 0;
    for (let i = 0; i <= span.length; i += 1) {
        if (i !== span.length && span[i] !== NEWLINE)
            continue;
        const segment = span.subarray(start, i);
        out.push(redactSegment(segment, projectRoot, resolver, counts));
        if (i !== span.length)
            out.push(span.subarray(i, i + 1));
        start = i + 1;
    }
    const bytes = Buffer.concat(out);
    // Length preservation is the property the server's offset accounting rests
    // on, so it is checked here too rather than trusted from the parts.
    if (bytes.length !== span.length) {
        return { bytes: span, redacted: 0, skipped: counts.redacted + counts.skipped };
    }
    return { bytes, ...counts };
}
function redactSegment(segment, projectRoot, resolver, counts) {
    const text = segment.toString("utf8");
    // A lossy decode (the span bisected a character) would re-encode to a
    // different length. Pass the raw bytes through instead.
    if (Buffer.byteLength(text) !== segment.length)
        return segment;
    const result = redactLine(text, projectRoot, resolver);
    counts.redacted += result.redacted;
    counts.skipped += result.skipped;
    if (result.line === text)
        return segment;
    const replaced = Buffer.from(result.line, "utf8");
    return replaced.length === segment.length ? replaced : segment;
}
/**
 * Walk the record, redacting content that sits beside an out-of-tree path.
 *
 * The rule is local and structural: within ONE object, a path key naming a file
 * outside the project root makes that object's content-bearing siblings
 * third-party content. That holds for every shape the transcript actually uses
 * — the tool_use input (`{file_path, content}`), the flat Edit result
 * (`{filePath, originalFile, oldString, newString, structuredPatch}`) and the
 * nested Read result (`file: {filePath, content}`) — without this module
 * needing to know which tool produced which.
 */
function walk(node, projectRoot, resolver, counts, 
/** True once an ancestor named a file outside the tree. */
inherited = false) {
    if (Array.isArray(node)) {
        for (const item of node)
            walk(item, projectRoot, resolver, counts, inherited);
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    // A nested object that names its OWN file decides for its own subtree: an
    // in-tree read quoted inside an out-of-tree record is still the user's own
    // content, and the reverse is still somebody else's.
    const named = namesAFile(record);
    const outOfTree = named === null ? inherited : !resolver(projectRoot, named);
    if (outOfTree) {
        for (const key of Object.keys(record)) {
            const value = record[key];
            if (CONTENT_KEYS.has(key) && typeof value === "string") {
                replaceString(record, key, value, counts);
            }
            else if (key === PATCH_KEY) {
                redactPatch(value, counts);
            }
        }
    }
    // ⚠ The verdict is INHERITED down the subtree, and that is the fix for a hole
    // this module shipped with in review: `MultiEdit`'s `edits: [{old_string,
    // new_string}]` sit one level BELOW the object carrying `file_path`, so a rule
    // that only redacted an object's own keys walked straight past a third party's
    // file content. Verified leaking before the change and redacted after.
    for (const value of Object.values(record)) {
        walk(value, projectRoot, resolver, counts, outOfTree);
    }
}
/** The path this object names, or null if it names none. */
function namesAFile(record) {
    for (const key of Object.keys(record)) {
        if (!PATH_KEYS.has(key))
            continue;
        const value = record[key];
        if (typeof value === "string" && value !== "")
            return value;
    }
    return null;
}
/** `structuredPatch: [{ lines: [...] }]` — the changed lines of the file. */
function redactPatch(patch, counts) {
    if (!Array.isArray(patch))
        return;
    for (const hunk of patch) {
        if (hunk === null || typeof hunk !== "object" || Array.isArray(hunk))
            continue;
        const lines = hunk.lines;
        if (!Array.isArray(lines))
            continue;
        for (let i = 0; i < lines.length; i += 1) {
            const value = lines[i];
            if (typeof value !== "string")
                continue;
            const marker = markerFor(value);
            if (marker === null) {
                counts.skipped += 1;
                continue;
            }
            lines[i] = marker;
            counts.redacted += 1;
        }
    }
}
function replaceString(record, key, value, counts) {
    const marker = markerFor(value);
    if (marker === null) {
        counts.skipped += 1;
        return;
    }
    record[key] = marker;
    counts.redacted += 1;
}
/**
 * A marker whose JSON-ENCODED byte length is exactly the original's.
 *
 * Encoded, not raw: what has to match is the bytes on the wire, and
 * `JSON.stringify` escapes newlines, quotes and control characters, so a
 * 400-byte source file is rarely 400 bytes of JSON. The marker is pure ASCII
 * with nothing `JSON.stringify` escapes, so its encoded length is simply its
 * own length plus the two quotes — which is what makes the padding exact.
 *
 * Null when even `[out-of-tree]` does not fit. The caller counts that and leaves
 * the value alone: a short span left intact is a small leak, and a mis-sized one
 * is a permanently gap-flagged stream.
 */
export function markerFor(original) {
    const target = Buffer.byteLength(JSON.stringify(original)) - 2;
    if (target < 0)
        return null;
    const head = REDACTION.head(Buffer.byteLength(original));
    const fill = target - head.length - REDACTION.tail.length;
    const marker = fill >= 0
        ? `${head}${REDACTION.fill.repeat(fill)}${REDACTION.tail}`
        : target >= REDACTION.short.length
            ? REDACTION.short + REDACTION.fill.repeat(target - REDACTION.short.length)
            : null;
    if (marker === null)
        return null;
    // Belt and braces: the arithmetic above is exact, and this is what proves it
    // for THIS value rather than in general.
    return Buffer.byteLength(JSON.stringify(marker)) === target + 2 ? marker : null;
}
/**
 * `isInside`, memoised for one span.
 *
 * `isInside` resolves BOTH sides with `realpathSync` — reused rather than
 * reimplemented, because a string prefix test is exactly what misses
 * `~/code/repo/x -> /etc`, the hole `/cso` finding 1 found in `paths.ts`. An
 * unresolvable path resolves to "outside", which here means REDACT: fail closed.
 *
 * The cache exists because one span can carry hundreds of records naming a
 * handful of paths, and each miss is two `realpath` syscalls against a hook's
 * wall-clock budget (DESIGN.md §13.7). It lives for one span and is not shared,
 * so a path that changes between invocations is re-resolved.
 */
function containment() {
    const seen = new Map();
    return (root, candidate) => {
        const key = `${root} ${candidate}`;
        const hit = seen.get(key);
        if (hit !== undefined)
            return hit;
        const inside = isInside(root, candidate);
        seen.set(key, inside);
        return inside;
    };
}
//# sourceMappingURL=redact.js.map