/**
 * The ONE terminal-safe function for server-supplied free text (rv-cap127c 3).
 *
 * M-a opens cross-member reads, so text a teammate's session produced (an excerpt, a tool name, a file, an agent id, an organization name, an echoed ref)
 * reaches this terminal. A control character in it is an escape-sequence injection: it can recolour, move the cursor, retitle the window or rewrite what
 * was already printed. So every such string goes through `terminalSafe` before it is printed. `--json` is NOT passed through it: JSON escapes control
 * characters itself, and a machine consumer gets the server's bytes.
 *
 * Removed: the C0 controls (U+0000-U+001F) except tab, and except newline when `multiline` is true; DEL; the C1 controls (U+0080-U+009F); and the Unicode
 * format controls, which are invisible and can reorder or hide text (zero-width characters, the left-to-right and right-to-left marks, the bidirectional
 * embeddings, overrides and isolates, the word joiner and the invisible operators, the byte-order mark, the tag characters, the soft hyphen).
 *
 * No regular expression on purpose: it runs over transcript text, and a loop over code points is linear by construction.
 */
/** Unicode general category Cf (format), written out as inclusive code point ranges. */
const FORMAT_RANGES = [
    [0x00ad, 0x00ad],
    [0x0600, 0x0605],
    [0x061c, 0x061c],
    [0x06dd, 0x06dd],
    [0x070f, 0x070f],
    [0x08e2, 0x08e2],
    [0x180e, 0x180e],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2060, 0x2064],
    [0x2066, 0x206f],
    [0xfeff, 0xfeff],
    [0xfff9, 0xfffb],
    [0x110bd, 0x110bd],
    [0x110cd, 0x110cd],
    [0x13430, 0x1343f],
    [0x1bca0, 0x1bca3],
    [0x1d173, 0x1d17a],
    [0xe0001, 0xe0001],
    [0xe0020, 0xe007f],
];
function isFormat(cp) {
    for (const [lo, hi] of FORMAT_RANGES)
        if (cp >= lo && cp <= hi)
            return true;
    return false;
}
/**
 * `multiline: true` keeps newline (the excerpt renderer wraps lines); the default is a ONE-LINE field (a tool, a file, an agent id, a ref, a name) in which a
 * newline would break the row, so it becomes a space. Tab is kept in both.
 */
export function terminalSafe(text, multiline = false) {
    let out = "";
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === 0x09)
            out += ch;
        else if (cp === 0x0a)
            out += multiline ? ch : " ";
        else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || isFormat(cp))
            continue;
        else
            out += ch;
    }
    return out;
}
//# sourceMappingURL=printable.js.map