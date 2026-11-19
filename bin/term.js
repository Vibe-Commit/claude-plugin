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
import { errorCodeLine } from "./copy/error_codes.js";
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
/**
 * §13.2 — the ONLY non-SGR escapes in the product, for the one interactive list (the `connect` picker, style guide
 * §10.12) and a beat line that is overwritten once. They draw nothing and carry no colour, so `NO_COLOR` does not
 * switch them off; §13.2's rules do: only a list a person is driving may redraw, a one-shot overwrite is withheld
 * under `NO_COLOR` and without a terminal, and there is NO hide-cursor, alternate screen, position query or mouse mode
 * (each leaves the terminal changed if the process dies first). This is the whole set.
 */
export const CURSOR = {
    up: (rows) => `\x1b[${rows}A`,
    clearLine: "\x1b[2K",
    clearBelow: "\x1b[0J",
    column1: "\r",
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
export function wrap(text, indent, hangingIndent = indent, width = WRAP_COLUMNS) {
    const words = text.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0)
        return [];
    const lines = [];
    let current = " ".repeat(indent);
    let currentIndent = indent;
    let empty = true;
    for (const word of words) {
        const candidate = empty ? current + word : `${current} ${word}`;
        if (!empty && candidate.length > width) {
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
/**
 * Shorten from the MIDDLE to `max` columns, keeping both ends — §13.4 for values whose start and
 * end both identify them (a workspace name, a handle). `truncatePath` cuts the left, which suits a
 * path whose tail is the name; here the head is just as much the name.
 */
export function truncateMiddle(text, max) {
    const chars = [...text];
    if (chars.length <= max)
        return text;
    if (max <= 1)
        return "…".slice(0, max);
    const head = Math.ceil((max - 1) / 2);
    const tail = max - 1 - head;
    return `${chars.slice(0, head).join("")}…${tail === 0 ? "" : chars.slice(chars.length - tail).join("")}`;
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
    // The code line: after the why paragraphs, before the blank line and the fix, so the fix stays last.
    // NEVER wrapped — it is an identifier and a path an agent matches on, and a wrapped one would not match.
    if (block.kind === "bad")
        out.push(paint(colour, "muted", `    ${errorCodeLine(block.code)}`));
    // A fix is a LABEL, with commands under it when there are any. PR 7: a label with no command (`NOT_A_REPO`: "Run it again
    // inside a git repository.") is a real fix and prints last; before, a label without commands was silently dropped.
    const fixes = block.fixes ?? [];
    if (block.fixLabel !== undefined && (fixes.length > 0 || block.kind === "bad")) {
        out.push("");
        for (const line of wrap(block.fixLabel, 4))
            out.push(line);
        for (const fix of fixes)
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
/**
 * Terminal columns one code point takes: 0 for a combining mark, 2 for a wide East Asian or emoji code point, 1 otherwise. A
 * small table, not a dependency: it covers the CJK, Hangul, fullwidth and common emoji blocks a folder or repository name uses.
 */
function codePointWidth(cp) {
    if (cp === 0)
        return 0;
    if (cp < 0x300)
        return 1;
    // Combining marks (the common blocks): a mark sits on the character before it and takes no column of its own.
    if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe20 && cp <= 0xfe2f))
        return 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f))
        return 0; // zero-width joiner and variation selectors
    const wide = (cp >= 0x1100 && cp <= 0x115f) ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x1f300 && cp <= 0x1f64f) ||
        (cp >= 0x1f900 && cp <= 0x1f9ff) ||
        (cp >= 0x20000 && cp <= 0x3fffd);
    return wide ? 2 : 1;
}
/**
 * Clip a line to at most `max` display columns, KEEPING its SGR escapes (they take no column) and never splitting a character.
 * A line cut while a colour is open ends with a reset, so the colour cannot run past the window. A line that fits is returned
 * unchanged, byte for byte.
 */
export function clipDisplay(line, max) {
    const esc = "\x1b";
    let out = "";
    let width = 0;
    let cut = false;
    let i = 0;
    while (i < line.length) {
        if (line[i] === esc && line[i + 1] === "[") {
            const end = line.indexOf("m", i);
            if (end !== -1 && /^\x1b\[[0-9;]*m$/.test(line.slice(i, end + 1))) {
                out += line.slice(i, end + 1);
                i = end + 1;
                continue;
            }
        }
        const cp = line.codePointAt(i) ?? 0;
        const ch = String.fromCodePoint(cp);
        const w = codePointWidth(cp);
        if (width + w > max) {
            cut = true;
            break;
        }
        out += ch;
        width += w;
        i += ch.length;
    }
    if (!cut)
        return line;
    return out.includes(esc) ? `${out}${SGR.reset}` : out;
}
//# sourceMappingURL=term.js.map