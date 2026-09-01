/**
 * Terminal primitives — the executable form of `DESIGN.md` §13.2–§13.5.
 *
 * §13.2 is explicit: "Every escape sequence in the product comes from here — no
 * literal `\x1b[` anywhere else in any repo, so the palette has exactly one
 * definition and `NO_COLOR` has exactly one switch." `test/term.test.ts` holds
 * that line with a source scan; it is the only reason the rule survives contact
 * with the fifteen tasks that build on this file.
 *
 * The governing constraint (§13): in a terminal we own only the foreground, and
 * the user's theme decides what every colour name resolves to. Base-16 SGR only —
 * no 24-bit, no 256-cube, and never a background fill.
 */
/** The six roles of §13.1. `text` is deliberately empty — see §13.2. */
export const SGR = {
    reset: "\x1b[0m",
    text: "",
    muted: "\x1b[2m",
    accent: "\x1b[36m",
    ok: "\x1b[32m",
    warn: "\x1b[33m",
    bad: "\x1b[31m",
    strong: "\x1b[1m",
};
/** §13.2 — status glyphs degrade to WORDS, never to nothing. */
export const GLYPH = {
    ok: { colour: "●", plain: "ok   " },
    warn: { colour: "●", plain: "warn " },
    bad: { colour: "●", plain: "error" },
};
/** §13.4 — hard wrap. Never `process.stdout.columns`. */
export const WRAP_COLUMNS = 80;
/** §13.5 — fixed key column for key/value output. */
export const LABEL_GUTTER = 11;
export function resolveColour(inputs) {
    if (inputs.json)
        return false;
    if (inputs.env.NO_COLOR !== undefined)
        return false;
    if (!inputs.isTty)
        return false;
    if (inputs.env.TERM === "dumb")
        return false;
    if (inputs.env.CI !== undefined)
        return false;
    if (inputs.noColorFlag)
        return false;
    return true;
}
/**
 * Wrap one SGR role around text. A no-op when colour is off, which is what makes
 * `NO_COLOR` a lossless degradation rather than a downgrade (§13.1): bold carries
 * structure, colour carries status, and the indentation carries the rest.
 */
export function paint(enabled, role, text) {
    const code = SGR[role];
    if (!enabled || code === "")
        return text;
    return `${code}${text}${SGR.reset}`;
}
/** §13.2 — the glyph, or the word it degrades to. */
export function glyph(enabled, kind) {
    return enabled ? GLYPH[kind].colour : GLYPH[kind].plain;
}
/**
 * §13.4 hard wrap at 80 columns INCLUDING the indent, with continuation lines
 * hung to `hangingIndent`.
 *
 * Operates on plain text only. Wrapping painted text would count escape bytes as
 * columns, so every caller wraps first and paints after — the reason `paint` is a
 * separate function rather than a parameter here.
 *
 * A single word longer than the available width (a URL, a path) is emitted on its
 * own line rather than broken: breaking a URL makes it uncopyable, which costs
 * more than the overflow.
 */
export function wrap(text, indent, hangingIndent = indent) {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0)
        return [];
    const lines = [];
    let current = " ".repeat(indent);
    let currentIndent = indent;
    let empty = true;
    for (const word of words) {
        const candidate = empty ? current + word : `${current} ${word}`;
        if (!empty && candidate.length > WRAP_COLUMNS) {
            lines.push(current);
            currentIndent = hangingIndent;
            current = " ".repeat(currentIndent) + word;
        }
        else {
            current = candidate;
        }
        empty = false;
    }
    lines.push(current);
    return lines;
}
/**
 * §13.4 — long paths truncate from the LEFT with a leading ellipsis, because the
 * filename identifies and the directory does not.
 */
export function truncatePath(path, max) {
    if (path.length <= max)
        return path;
    return `…${path.slice(path.length - (max - 1))}`;
}
/** §13.5 — key/value output on the fixed label gutter. */
export function labelled(indent, key, value) {
    return `${" ".repeat(indent)}${key.padEnd(LABEL_GUTTER)}${value}`;
}
export function renderErrorBlock(block, colour) {
    const out = [];
    const marker = glyph(colour, block.kind);
    for (const [i, line] of wrap(block.what, 2 + marker.length + 1, 4).entries()) {
        out.push(i === 0
            ? `  ${paint(colour, block.kind, marker)} ${paint(colour, "strong", line.trimStart())}`
            : paint(colour, "strong", line));
    }
    for (const paragraph of block.why) {
        for (const line of wrap(paragraph, 4))
            out.push(paint(colour, "muted", line));
    }
    if (block.fixLabel !== undefined && block.fixes !== undefined && block.fixes.length > 0) {
        out.push("");
        for (const line of wrap(block.fixLabel, 4))
            out.push(line);
        for (const fix of block.fixes)
            out.push(`      ${paint(colour, "accent", fix)}`);
    }
    return out;
}
/**
 * `/Users/dev/code/x` -> `~/code/x`, as §10.3 draws it.
 *
 * Lived in `status.ts` while the repo row was its only caller. `CR-216/U2` gives
 * it a second one — `auth` names the file it wrote — and a second COPY of it
 * would be a second thing to get wrong about `home === ""`, which is the value
 * `index.ts` falls back to and the one case where the tilde must not be applied.
 */
export function tildePath(path, home) {
    if (home !== "" && (path === home || path.startsWith(`${home}/`))) {
        return `~${path.slice(home.length)}`;
    }
    return path;
}
//# sourceMappingURL=term.js.map