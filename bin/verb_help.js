/**
 * `<verb> --help` — PR 6 item 2 (devex review).
 *
 * The one-sentence description stays the first paragraph (it is the verbatim-approved copy for `why`, D61 §PS6), and what
 * follows is usage, flags and exit codes, from `HELP.verbs`. Agents read `--help` first, and until now the flags and the
 * exit codes of a verb existed only in the README.
 *
 * Wrapped hard at 80 columns (§13.4) and never reflowed to the terminal, with no SGR at all: it is the same rule as the
 * top-level help, for the same reason (identical commands must emit identical bytes, or every golden file breaks).
 */
import { HELP, USAGE } from "./copy/index.js";
import { wrap } from "./term.js";
/** A two-column list: the left cell padded to the widest, the right wrapped with a hanging indent. */
function table(rows) {
    const width = Math.max(...rows.map(([left]) => left.length));
    const out = [];
    for (const [left, right] of rows) {
        // Wrapped on its own and the left cell written over the first line's indent, as `renderHelp` does for the verb column:
        // wrapping `left + padding + right` as one string would collapse the padding.
        const head = `    ${left.padEnd(width)}  `;
        const body = wrap(right, head.length);
        out.push(head + body[0].slice(head.length), ...body.slice(1));
    }
    return out;
}
export function renderVerbHelp(verb) {
    const help = HELP.verbs[verb];
    return [
        ...wrap(HELP.commands[verb], 2),
        "",
        ...wrap(`${USAGE.usageLabel} ${help.usage}`, 2),
        "",
        ...wrap(HELP.optionsLabel, 2),
        ...(help.options.length === 0 ? wrap(HELP.noOptions, 4) : table(help.options)),
        "",
        ...wrap(HELP.exitCodesLabel, 2),
        ...table(help.exits),
    ];
}
//# sourceMappingURL=verb_help.js.map