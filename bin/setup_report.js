/**
 * The setup report's agent table (plan 4.2, T8, DX-13, ENG-16, ENG-17). Pure: the rows the install produced in, the lines out. No
 * I/O, no clock, no environment reads. `connect` prints it; the proof sentence and the Codex trust line are read from the same rows, so
 * the report and the proof cannot disagree about which agent is set up.
 */
import { AGENT_HOOKS, SETUP } from "./copy/index.js";
import { terminalSafe } from "./printable.js";
import { paint, truncatePath, WRAP_COLUMNS, wrap } from "./term.js";
const INDENT = 4;
/** The label column: the longest label plus a gap, so the paths line up. */
const LABEL_COLUMN = 14;
/** A row is working when its file holds our hooks after this run. */
export function isWorking(row) {
    return row.outcome === "added" || row.outcome === "already";
}
/** The outcome word, as the plan gives it. */
function outcomeWord(outcome) {
    switch (outcome) {
        case "added":
            return AGENT_HOOKS.rowAdded;
        case "already":
            return AGENT_HOOKS.rowAlready;
        case "failed":
            return AGENT_HOOKS.rowFailed;
        case "refused":
            return AGENT_HOOKS.rowRefused;
    }
}
/**
 * The table and its two notes. Paths are cut from the left to fit 80 columns with the longest outcome word (§13.4). `Hooks you already
 * had…` prints once, and only when a file was added to. The Codex trust line prints once, under the table, only when the Codex file was
 * written this run (added or refreshed), and never on a re-run that wrote nothing (ENG-16).
 */
export function setupReportLines(rows, colour, commit = null) {
    if (rows.length === 0 && commit === null)
        return [];
    const longestWord = rows.length === 0 ? 0 : Math.max(...rows.map((row) => outcomeWord(row.outcome).length));
    const pathBudget = WRAP_COLUMNS - INDENT - LABEL_COLUMN - 2 - longestWord;
    // #7 (CR-PRB1): a config path is printed as the terminal's text, so its control characters go before the table is cut.
    const paths = rows.map((row) => truncatePath(terminalSafe(row.path), pathBudget));
    const pathColumn = paths.length === 0 ? 0 : Math.max(...paths.map((path) => path.length)) + 2;
    const lines = [];
    // T8b (4.2): the commit-hooks row comes first, as the plan draws it. It is printed only when a clone got a hook this run.
    if (commit !== null && commit.clones > 0) {
        lines.push(`${" ".repeat(INDENT)}${paint(colour, "text", "commit hooks".padEnd(LABEL_COLUMN))}${paint(colour, "text", SETUP.commitRow(commit.clones, commit.chained))}`);
    }
    for (const [index, row] of rows.entries()) {
        lines.push(`${" ".repeat(INDENT)}${paint(colour, "text", row.label.padEnd(LABEL_COLUMN))}${paint(colour, "text", paths[index].padEnd(pathColumn))}${paint(colour, "muted", outcomeWord(row.outcome))}`);
    }
    if (lines.length === 0)
        return [];
    const notes = [];
    if (rows.some((row) => row.outcome === "added"))
        notes.push(...wrap(AGENT_HOOKS.keptOnce, INDENT).map((line) => paint(colour, "muted", line)));
    if (rows.some((row) => row.agentId === "codex-cli" && row.changed && isWorking(row))) {
        notes.push(...wrap(AGENT_HOOKS.codexTrust, INDENT).map((line) => paint(colour, "muted", line)));
    }
    return notes.length > 0 ? [...lines, "", ...notes] : lines;
}
/** `Claude Code, Codex or Cursor`: the names of the working agents, in the order given, joined the way the plan's sentence joins them. */
export function workingNames(labels) {
    if (labels.length <= 1)
        return labels.join("");
    return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}
//# sourceMappingURL=setup_report.js.map