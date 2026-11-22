/**
 * The arrow-key checklist — style guide §10.12 "The arrow-key checklist", design review D28 · 22B.
 *
 * Two halves, so the interesting one is testable without a terminal:
 *
 *   - `initChecklist` / `step` / `renderFrame` are PURE: a state, a key, a frame. `test/picker-checklist.test.ts` drives
 *     them with synthetic keys, which is the "keypress-driven state test" the design asks for (the frames themselves are
 *     not golden-tested; the static `You chose:` block that replaces them is).
 *   - `runChecklist` is the thin driver: raw mode, `keypress` events, the redraw, and the exits.
 *
 * ## ⛔ Raw mode is the one terminal state this changes, and it is restored on EVERY exit path
 *
 * Confirm, Ctrl+C, `t`, a throw inside the handler, `SIGTERM`/`SIGINT`/`SIGHUP`, and a process `exit` that nothing here
 * caused. The last is the net under the others: a raw-mode terminal left behind is a shell that echoes nothing. No
 * hide-cursor, no alternate screen, no position query (DESIGN.md §13.2 `CURSOR` is the whole set), so there is nothing
 * else to undo. ⚠ A signal handler restores first and only THEN lets the default termination run.
 *
 * Redraw happens on a keypress and only on a keypress (§13.8): an idle list emits zero bytes.
 */
import { emitKeypressEvents } from "node:readline";
import { GROUP_CAP, notListedBlock, } from "./picker.js";
import { SCAN, PICKER, shortDate } from "./copy/index.js";
import { CURSOR, WRAP_COLUMNS, clipDisplay, paint, truncateMiddle, wrap } from "./term.js";
const AGENTS = ["claude-code", "codex-cli", "cursor"];
/** 4.6: at most this many selectable rows are drawn, and rows plus their group headings take at most `MAX_LINES` lines. */
const MAX_ROWS = 12;
const MAX_LINES = 15;
const GAP = 3;
/** `  › [x] ` — a cursor column and a tick box ahead of the name. */
const LEAD = 8;
/** The `expanded` key of the folders group's `+ N more` row. Not an owner: owners are `host/name`, never this. */
const FOLDERS_KEY = "\u0000folders";
/** The `expanded` key of the collapsed temporary-folders row (D-TEMP, T5c). */
const TEMP_KEY = "\u0000temp";
/** The selectable rows in screen order, given what is expanded. */
export function checklistRows(model, expanded) {
    const rows = model.onNow.map((row) => ({ id: `on:${row.kind}:${row.key}`, kind: "on", row }));
    for (const group of model.owners) {
        rows.push({ id: `all:${group.owner}`, kind: "all", group });
        const shown = expanded.has(group.owner) ? group.repos : group.repos.slice(0, GROUP_CAP);
        for (const repo of shown)
            rows.push({ id: `repo:${repo.slug}`, kind: "repo", repo, group });
        const hidden = group.repos.length - shown.length;
        if (hidden > 0)
            rows.push({ id: `more:${group.owner}`, kind: "more", group, hidden });
    }
    const shownFolders = expanded.has(FOLDERS_KEY) ? model.folders : model.folders.slice(0, GROUP_CAP);
    for (const folder of shownFolders)
        rows.push({ id: `folder:${folder.path}`, kind: "folder", folder });
    if (model.folders.length > shownFolders.length)
        rows.push({ id: "morefolders", kind: "morefolders", hidden: model.folders.length - shownFolders.length });
    // D-TEMP: one collapsed row at the end of the folders group; expanded in place, its folders are ordinary folder rows.
    if (model.temporaryFolders.length > 0) {
        if (expanded.has(TEMP_KEY)) {
            for (const folder of model.temporaryFolders)
                rows.push({ id: `folder:${folder.path}`, kind: "folder", folder });
        }
        else {
            rows.push({ id: "temp:collapsed", kind: "temp", hidden: model.temporaryFolders.length });
        }
    }
    for (const row of model.account)
        rows.push({ id: `account:${row.kind}:${row.key}`, kind: "account", row });
    for (const row of model.turnedOff)
        rows.push({ id: `off:${row.slug}`, kind: "off", row });
    return rows;
}
export function initChecklist(model) {
    const ticked = new Set();
    for (const row of model.onNow)
        ticked.add(`on:${row.kind}:${row.key}`);
    for (const group of model.owners) {
        for (const repo of group.repos)
            if (repo.pre)
                ticked.add(`repo:${repo.slug}`);
    }
    for (const row of model.turnedOff)
        if (row.pre)
            ticked.add(`off:${row.slug}`);
    const rows = checklistRows(model, new Set());
    const start = startRow(rows);
    const state = { cursor: start?.id ?? "", ticked, expanded: new Set(), notice: null, first: 0 };
    return withWindow(model, state);
}
/**
 * D-CURSOR (4.4): "this repo" if present, else the most recent individual repo row (never the `$HOME` dotfiles row), else the first
 * folder row. Never an `on now`, `all` or `+ N more` row while one of those exists. A list with none of them starts on its first row.
 */
function startRow(rows) {
    const pre = rows.find((r) => (r.kind === "repo" && r.repo.pre) || (r.kind === "off" && r.row.pre));
    if (pre !== undefined)
        return pre;
    let newest;
    for (const r of rows) {
        // FA3 (ENG-12): the `$HOME` dotfiles row (`here: "folder"`) is never where the cursor starts.
        if (r.kind === "repo" && r.repo.here !== "folder" && (newest === undefined || (newest.kind === "repo" && r.repo.latestMs > newest.repo.latestMs)))
            newest = r;
    }
    return newest ?? rows.find((r) => r.kind === "folder") ?? rows[0];
}
/** The group a row's heading belongs to: one heading per group, drawn above the first visible row of the group. */
function groupOf(row) {
    switch (row.kind) {
        case "on":
            return "on";
        case "all":
        case "repo":
        case "more":
            return `owner:${row.group.owner}`;
        case "folder":
        case "morefolders":
        case "temp":
            return "folders";
        case "account":
            return "account";
        case "off":
            return "off";
    }
}
/**
 * The window (4.6, ENG-12): a top-anchored run of selectable rows. Its first row moves the least distance from `prevFirst` that
 * keeps the cursor visible and off the first and last visible rows (unless the cursor is at the list's start or end). From the
 * first row, rows are added in order while there are at most 12 selectable rows and rows plus their headings take at most 15
 * lines. Exported for the window's cells: `at` is the cursor's index in `rows`, or any index when `rows` is empty.
 */
export function checklistWindow(rows, at, prevFirst) {
    const n = rows.length;
    if (n === 0)
        return { first: 0, last: -1 };
    const cursor = Math.min(n - 1, Math.max(0, at));
    const fit = (first) => {
        const groups = new Set();
        let last = first;
        let count = 0;
        for (let i = first; i < n; i++) {
            const group = groupOf(rows[i]);
            const headings = groups.size + (groups.has(group) ? 0 : 1);
            // The first row always fits: a single row and its heading are always within the budget.
            if (i > first && (count + 1 > MAX_ROWS || count + 1 + headings > MAX_LINES))
                break;
            groups.add(group);
            count += 1;
            last = i;
        }
        return last;
    };
    let first = Math.min(n - 1, Math.max(0, prevFirst));
    // Scroll up only as far as the cursor needs: the cursor is never the first visible row unless it is the list's first row.
    if (cursor > 0 && cursor <= first)
        first = cursor - 1;
    let last = fit(first);
    // Scroll down only as far as the cursor needs: never the last visible row unless it is the list's last row.
    while (cursor >= last && last < n - 1 && first < cursor) {
        first += 1;
        last = fit(first);
    }
    return { first, last };
}
/** The window the state's cursor and `first` give, stored back into the state (so the next frame moves from it). */
function withWindow(model, state) {
    const rows = checklistRows(model, state.expanded);
    const at = Math.max(0, rows.findIndex((r) => r.id === state.cursor));
    const first = checklistWindow(rows, at, state.first).first;
    return first === state.first ? state : { ...state, first };
}
function withTick(state, id, on) {
    const ticked = new Set(state.ticked);
    if (on)
        ticked.add(id);
    else
        ticked.delete(id);
    return { ...state, ticked };
}
/** A repo under a ticked `all` row is covered, so it reads as ticked and is not separately togglable. */
export function isCovered(state, row) {
    return row.kind === "repo" && state.ticked.has(`all:${row.group.owner}`);
}
/** No change against the baseline: Enter has nothing to continue with. */
function isEmptyChange(c) {
    return (c.addOwners.length + c.addRepos.length + c.turnOn.length + c.stopOwners.length + c.stopRepos.length + c.stopClones.length +
        (c.addFolders?.length ?? 0) + (c.stopFolders?.length ?? 0) === 0);
}
export function step(model, previous, key, options = {}) {
    const result = stepKey(model, previous, key, options);
    return result.kind === "state" ? { kind: "state", state: withWindow(model, result.state) } : result;
}
function stepKey(model, previous, key, 
/**
 * `g` is a key only where the picker offered it (no credential, a terminal, a browser); anywhere else it does nothing.
 * `enterFinishesSetup` (4.4a, 2B): Enter with nothing new finishes setup (the picker turns it on when a setup predicate holds).
 */
options = {}) {
    // A sentence lasts until the next key (4.4): the key clears it.
    const state = previous.notice === null ? previous : { ...previous, notice: null };
    const rows = checklistRows(model, state.expanded);
    // Enter (4.4): it continues when something differs from the baseline (a pre-ticked repo counts); with nothing new it stays.
    const enter = () => {
        const change = changeOf(model, state);
        if (!isEmptyChange(change) || options.enterFinishesSetup === true)
            return { kind: "done", change };
        return { kind: "state", state: { ...state, notice: PICKER.stayNothing } };
    };
    const at = Math.max(0, rows.findIndex((r) => r.id === state.cursor));
    const current = rows[at];
    switch (key.name) {
        case "up":
            return { kind: "state", state: { ...state, cursor: rows[Math.max(0, at - 1)]?.id ?? state.cursor } };
        case "down":
            return { kind: "state", state: { ...state, cursor: rows[Math.min(rows.length - 1, at + 1)]?.id ?? state.cursor } };
        case "space":
        case "return": {
            if (current === undefined)
                return key.name === "return" ? enter() : { kind: "state", state };
            if (current.kind === "more") {
                const expanded = new Set(state.expanded).add(current.group.owner);
                // The cursor lands on the first row the expansion revealed: the row that replaced the `+` row (4.6).
                const revealed = current.group.repos[GROUP_CAP];
                return { kind: "state", state: { ...state, expanded, cursor: revealed ? `repo:${revealed.slug}` : state.cursor } };
            }
            if (current.kind === "temp") {
                // D-TEMP: expands in place; the cursor lands on the first temporary folder it revealed.
                const expanded = new Set(state.expanded).add(TEMP_KEY);
                const first = model.temporaryFolders[0];
                return { kind: "state", state: { ...state, expanded, cursor: first ? `folder:${first.path}` : state.cursor } };
            }
            if (current.kind === "morefolders") {
                const expanded = new Set(state.expanded).add(FOLDERS_KEY);
                const revealed = model.folders[GROUP_CAP];
                return { kind: "state", state: { ...state, expanded, cursor: revealed ? `folder:${revealed.path}` : state.cursor } };
            }
            if (key.name === "return")
                return enter();
            if (isCovered(state, current))
                return { kind: "state", state: { ...state, notice: PICKER.coveredFooter } };
            const next = withTick(state, current.id, !state.ticked.has(current.id));
            if (current.kind === "all" && next.ticked.has(current.id)) {
                // The owner row covers every repo of the owner, hidden ones included: drop their single ticks.
                const ticked = new Set(next.ticked);
                for (const repo of current.group.repos)
                    ticked.delete(`repo:${repo.slug}`);
                return { kind: "state", state: { ...next, ticked } };
            }
            return { kind: "state", state: next };
        }
        case "t":
            return { kind: "typed" };
        case "q":
        case "escape":
            return { kind: "quit" };
        case "g":
            return options.offerAccount === true ? { kind: "account" } : { kind: "state", state };
        case "ctrl-c":
            return { kind: "cancel" };
        default:
            return { kind: "state", state };
    }
}
/**
 * What the ticks change against the baseline (the `on now` rows, ticked). An `on` row unticked is a removal; an `all` row
 * ticked an owner grant; a repo ticked, with its owner not ticked, a repo grant; an `off` row ticked a re-include. A
 * pre-ticked repo is an addition like any other: Enter on it reaches the y/N, never a grant (D34).
 */
export function changeOf(model, state) {
    const change = {
        addOwners: [],
        addRepos: [],
        turnOn: [],
        stopOwners: [],
        stopRepos: [],
        stopClones: [],
    };
    const add = (list, value) => {
        if (!list.includes(value))
            list.push(value);
    };
    const addFolders = [];
    const stopFolders = [];
    for (const row of model.onNow) {
        if (state.ticked.has(`on:${row.kind}:${row.key}`))
            continue;
        if (row.kind === "owner")
            change.stopOwners.push(row.key);
        else if (row.kind === "repo")
            change.stopRepos.push(row.key);
        else if (row.kind === "folder")
            stopFolders.push(row.key);
        else
            change.stopClones.push(row.key);
    }
    for (const group of model.owners) {
        if (state.ticked.has(`all:${group.owner}`)) {
            add(change.addOwners, group.owner);
            continue;
        }
        for (const repo of group.repos)
            if (state.ticked.has(`repo:${repo.slug}`))
                add(change.addRepos, repo.slug);
    }
    // The account's grants (slice 2): an owner row is an owner grant, a repo row a repo grant (unless its owner is chosen too).
    for (const row of model.account) {
        if (!state.ticked.has(`account:${row.kind}:${row.key}`))
            continue;
        if (row.kind === "owner")
            add(change.addOwners, row.key);
    }
    for (const row of model.account) {
        if (row.kind !== "repo" || !state.ticked.has(`account:repo:${row.key}`))
            continue;
        if (!change.addOwners.includes(row.key.slice(0, Math.max(0, row.key.lastIndexOf("/")))))
            add(change.addRepos, row.key);
    }
    for (const row of model.turnedOff)
        if (state.ticked.has(`off:${row.slug}`))
            change.turnOn.push(row.slug);
    // D-TEMP: an expanded temporary folder is an ordinary folder row, so it is granted like one (T5c).
    for (const folder of [...model.folders, ...model.temporaryFolders])
        if (state.ticked.has(`folder:${folder.path}`))
            addFolders.push(folder.path);
    // Present only when something changed, so a repo-only pick is exactly the object it always was.
    return {
        ...change,
        ...(addFolders.length > 0 ? { addFolders } : {}),
        ...(stopFolders.length > 0 ? { stopFolders } : {}),
    };
}
function counts(c, nowMs) {
    return c === null || c.sessions === 0 ? "" : `${SCAN.sessions(c.sessions)} · ${SCAN.since(shortDate(c.sinceMs, nowMs))}`;
}
function agents(c) {
    if (c === null || c.sessions === 0)
        return "";
    const used = AGENTS.filter((a) => c.agents[a] > 0);
    return used.length > 1 ? used.map((a) => SCAN.agent[a]).join(", ") : "";
}
/**
 * The static block (4.1): printed ONCE per run, above the first frame, and never redrawn. `Found`, the screen-reader line, and
 * `Not listed here:` (with a blank line before it when there is one).
 */
export function checklistHeader(model, colour, typedCommand, columns) {
    const width = frameWidth(columns);
    // FD1: the header is printed once and never erased, so it is wrapped and NEVER clipped: a command is drawn whole. The screen-reader
    // line keeps its command on its own line when the two do not fit together (a plugin path is one unbreakable word).
    const hint = PICKER.hintTyped(typedCommand);
    const hintLines = hint.length + 2 <= width ? [`  ${hint}`] : [`  ${PICKER.hintTyped("").trimEnd()}`, `  ${typedCommand}`];
    return [
        "",
        ...wrap(SCAN.found(model.found), 2, 2, width).map((l) => paint(colour, "strong", l)),
        ...hintLines.map((l) => paint(colour, "muted", l)),
        ...notListedBlock(model, colour, width),
        // The blank line before the list: part of the static block, so the live frame starts at its first row (4.6's budget).
        "",
    ];
}
/**
 * FA2 / FD2: the frame's width. Lines are laid out and clipped to `min(80, columns) - 1`: a line of exactly 80 columns is never drawn on
 * an 80-column terminal (its last column is the one a terminal may not let us fill), so the layout never needs a clip at 80. A width that
 * is undefined, 0 or negative is a terminal that does not say, and lays out at 80 (a 0 from Node is not a width of 0).
 */
export function frameWidth(columns) {
    const known = columns !== undefined && columns > 0 ? columns : WRAP_COLUMNS;
    return Math.min(WRAP_COLUMNS, known) - 1;
}
/** The count line (4.1): what the ticks change against the baseline, one line. */
export function countLine(model, state) {
    const c = changeOf(model, state);
    const added = c.addOwners.length + c.addRepos.length + c.turnOn.length + (c.addFolders?.length ?? 0);
    const stopped = c.stopOwners.length + c.stopRepos.length + c.stopClones.length + (c.stopFolders?.length ?? 0);
    if (added === 0 && stopped === 0)
        return PICKER.countNone;
    if (stopped === 0)
        return PICKER.countAdd(added);
    if (added === 0)
        return PICKER.countStop(stopped);
    return PICKER.countBoth(added, stopped);
}
/** The frame, as lines. The cursor row is `strong` and marked `›`; no reverse video, no fill (§13.1). */
export function renderFrame(model, state, options) {
    const { colour, nowMs } = options;
    const rows = checklistRows(model, state.expanded);
    const width = frameWidth(options.columns);
    // Name column, as the typed screen sizes it.
    const metaOf = (row) => {
        if (row.kind === "on") {
            const r = row.row;
            return r.kind === "owner"
                ? { name: `${r.key}/`, meta: [r.reason, PICKER.ownerOnReposHere(r.reposHere)].join(" · "), agents: "" }
                : { name: r.kind === "folder" ? (r.label ?? r.key) : r.key, meta: [r.reason, counts(r.counts, nowMs)].filter(Boolean).join(" · "), agents: agents(r.counts) };
        }
        if (row.kind === "repo") {
            const flag = row.repo.here === "repo" ? PICKER.thisRepo : row.repo.here === "folder" ? PICKER.thisFolder : "";
            // D-COVERED (4.4): a repo under a ticked `all` row reads `covered by all`.
            const covered = isCovered(state, row) ? PICKER.coveredBy : "";
            return {
                name: row.repo.name,
                meta: [counts(row.repo, nowMs), flag, covered].filter(Boolean).join(" · "),
                agents: agents(row.repo),
            };
        }
        if (row.kind === "folder") {
            const f = row.folder;
            return {
                name: f.label,
                meta: [f.excluded === true ? PICKER.turnOnHint : "", counts(f, nowMs)].filter(Boolean).join(" · "),
                agents: agents(f),
            };
        }
        if (row.kind === "off")
            return { name: row.row.slug, meta: PICKER.turnOnHint, agents: "" };
        if (row.kind === "account") {
            return { name: row.row.kind === "owner" ? `${row.row.key}/` : row.row.key, meta: PICKER.onAccountHint, agents: "" };
        }
        return { name: "", meta: "", agents: "" };
    };
    const named = rows.map((r) => ({ row: r, ...metaOf(r) })).filter((r) => r.name !== "");
    const longestMeta = named.reduce((n, r) => Math.max(n, r.meta.length), 0);
    const longestName = named.reduce((n, r) => Math.max(n, r.name.length), 0);
    const column = Math.max(12, Math.min(longestName, width - LEAD - GAP - longestMeta));
    const cut = (name) => {
        if (name.length <= column)
            return name;
        const slash = name.lastIndexOf("/");
        return slash >= 0 && slash + 1 < column
            ? `${name.slice(0, slash + 1)}${truncateMiddle(name.slice(slash + 1), column - slash - 1)}`
            : truncateMiddle(name, column);
    };
    const line = (row, text, mutedTail) => {
        const here = row.id === state.cursor;
        const lead = here ? "  › " : "    ";
        // One colour per line: the cursor row is `strong` throughout, the others keep `muted` for their counts.
        return here ? paint(colour, "strong", `${lead}${text}${mutedTail}`) : `${lead}${text}${paint(colour, "muted", mutedTail)}`;
    };
    const box = (row) => state.ticked.has(row.id) || isCovered(state, row) ? "[x]" : "[ ]";
    // The static block (Found, the screen-reader line, `Not listed here:`) is NOT here: `runChecklist` prints it once.
    // The window (4.6): only its rows are drawn, with an edge line for each side that has rows above or below it.
    const at = Math.max(0, rows.findIndex((r) => r.id === state.cursor));
    const win = checklistWindow(rows, at, state.first);
    const out = [];
    if (win.first > 0)
        out.push(paint(colour, "muted", `  ${PICKER.moreAbove(win.first)}`));
    const seenOwner = new Set();
    let wroteOn = false;
    let wroteAccount = false;
    let wroteOff = false;
    let wroteFolders = false;
    for (const entry of rows.slice(win.first, win.last + 1)) {
        const m = metaOf(entry);
        if (entry.kind === "on") {
            if (!wroteOn) {
                out.push(paint(colour, "muted", `  ${PICKER.onNow}`));
                wroteOn = true;
            }
        }
        else if (entry.kind === "all" || entry.kind === "repo" || entry.kind === "more") {
            const owner = entry.group.owner;
            if (!seenOwner.has(owner)) {
                seenOwner.add(owner);
                out.push(`  ${paint(colour, "text", `${owner}/`)}`);
            }
        }
        else if ((entry.kind === "folder" || entry.kind === "morefolders" || entry.kind === "temp") && !wroteFolders) {
            out.push(paint(colour, "muted", `  ${PICKER.folders}`));
            wroteFolders = true;
        }
        else if (entry.kind === "account" && !wroteAccount) {
            out.push(paint(colour, "muted", `  ${PICKER.onAccount}`));
            wroteAccount = true;
        }
        else if (entry.kind === "off" && !wroteOff) {
            out.push(paint(colour, "muted", `  ${PICKER.turnedOff}`));
            wroteOff = true;
        }
        if (entry.kind === "all") {
            out.push(line(entry, `${box(entry)} ${PICKER.ownerAll(entry.group.repos.length)}`, ""));
        }
        else if (entry.kind === "more") {
            out.push(paint(colour, "muted", `${entry.id === state.cursor ? "  › " : "    "}+   ${PICKER.moreChecklist(entry.hidden, entry.group.owner)}`));
        }
        else if (entry.kind === "morefolders") {
            out.push(paint(colour, "muted", `${entry.id === state.cursor ? "  › " : "    "}+   ${PICKER.moreFoldersChecklist(entry.hidden)}`));
        }
        else if (entry.kind === "temp") {
            out.push(paint(colour, "muted", `${entry.id === state.cursor ? "  › " : "    "}+   ${PICKER.temporaryFolders(entry.hidden)}`));
        }
        else {
            const withAgents = m.agents !== "" && LEAD + column + GAP + m.meta.length + 3 + m.agents.length <= width
                ? `${m.meta} · ${m.agents}`
                : m.meta;
            out.push(line(entry, `${box(entry)} ${cut(m.name).padEnd(column)}`, `${" ".repeat(GAP)}${withAgents}`));
        }
    }
    if (win.last < rows.length - 1)
        out.push(paint(colour, "muted", `  ${PICKER.moreBelow(rows.length - 1 - win.last)}`));
    // The footer (4.1, 4.13a): the legend is the frame's last block, with the count line under it; the g line (where offered) is last.
    out.push("");
    out.push(paint(colour, "text", `  ${PICKER.hint}`));
    // 2B: with nothing new chosen and setup unfinished, the count line says Enter finishes setup (verbatim from the plan).
    const count = countLine(model, state);
    const finishLine = options.enterFinishesSetup === true && count === PICKER.countNone ? PICKER.enterFinishes : count;
    out.push(paint(colour, "strong", `  ${state.notice ?? finishLine}`));
    if (options.offerAccount === true)
        out.push(...wrap(PICKER.gLine, 2, 2, width).map((l) => paint(colour, "muted", l)));
    // ⛔ One line is one terminal row: a line wider than the window would wrap and leave debris on the next redraw (ENG-33).
    return out.map((l) => clipDisplay(l, width));
}
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
function keyOf(str, key) {
    if (key?.ctrl === true && key.name === "c")
        return { name: "ctrl-c" };
    // Esc followed by ANY key within readline's escape timeout arrives meta-flagged (ENG-39): it is read as Esc, which quits.
    if (key?.meta === true)
        return { name: "escape" };
    switch (key?.name) {
        case "up":
        case "down":
        case "return":
            return { name: key.name };
        case "space":
            return { name: "space" };
        case "t":
            return { name: "t" };
        case "g":
            return { name: "g" };
        case "q":
            return { name: "q" };
        case "escape":
            return { name: "escape" };
        default:
            return str === " " ? { name: "space" } : { name: "other" };
    }
}
/**
 * Run the checklist. Resolves with what the person chose, or that they asked for the typed prompt, or cancelled. The
 * frame is ERASED before returning, so what is left on screen is whatever the caller prints next (the static
 * `You chose:` block), never a half-drawn list.
 */
export function runChecklist(model, options, deps) {
    const { input, output } = deps;
    const signals = deps.signals ?? process;
    const onExit = deps.onExit ?? process;
    const terminate = deps.terminate ?? ((signal) => void process.kill(process.pid, signal));
    return new Promise((resolve, reject) => {
        let resizeTimer;
        // ⛔ A resize (debounced) writes one newline and draws a fresh frame below it, erasing nothing drawn before (ENG-33): the old
        // frame stays in scrollback, and the new frame is clipped to the new width, so no line wraps into the next redraw's count.
        const onResize = () => {
            if (resizeTimer !== undefined)
                clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                resizeTimer = undefined;
                if (finished)
                    return;
                output.write("\n");
                drawn = 0;
                draw();
            }, 50);
        };
        let state = initChecklist(model);
        let drawn = 0;
        let raw = false;
        let finished = false;
        let headerWritten = false;
        const restore = () => {
            if (!raw)
                return;
            raw = false;
            try {
                input.setRawMode?.(false);
            }
            catch {
                // The stream is gone; there is no terminal state left to restore.
            }
        };
        const draw = () => {
            const columns = options.columns?.();
            const lines = renderFrame(model, state, { colour: options.colour, nowMs: options.nowMs, typedCommand: options.typedCommand, offerAccount: options.offerAccount, enterFinishesSetup: options.enterFinishesSetup, columns });
            // The static block goes out with the FIRST frame, once: it is never erased (`drawn` counts the frame only).
            const header = !headerWritten && options.headerPrinted !== true ? `${checklistHeader(model, options.colour, options.typedCommand, columns).join("\n")}\n` : "";
            headerWritten = true;
            output.write(`${header}${drawn > 0 ? `${CURSOR.up(drawn)}${CURSOR.column1}${CURSOR.clearBelow}` : ""}${lines.join("\n")}\n`);
            drawn = lines.length;
        };
        // ⛔ Never throws: it runs on the error paths, ahead of `cleanup`, and an output that is itself failing (a closed pipe)
        // must not stop the terminal being restored.
        const erase = () => {
            try {
                if (drawn > 0)
                    output.write(`${CURSOR.up(drawn)}${CURSOR.column1}${CURSOR.clearBelow}`);
            }
            catch {
                // Nothing to erase on a stream that cannot be written.
            }
            drawn = 0;
        };
        const signalHandlers = new Map();
        const exitHook = () => restore();
        const cleanup = () => {
            input.off("keypress", onKey);
            if (resizeTimer !== undefined)
                clearTimeout(resizeTimer);
            if (typeof output.off === "function")
                output.off("resize", onResize);
            for (const [signal, handler] of signalHandlers)
                signals.off(signal, handler);
            onExit.off("exit", exitHook);
            restore();
            input.pause();
        };
        const finish = (result) => {
            if (finished)
                return;
            finished = true;
            erase();
            cleanup();
            resolve(result);
        };
        function onKey(str, key) {
            if (finished)
                return;
            try {
                const result = step(model, state, keyOf(str, key), { offerAccount: options.offerAccount === true, enterFinishesSetup: options.enterFinishesSetup === true });
                if (result.kind === "state") {
                    const before = state;
                    state = result.state;
                    if (state !== before)
                        draw();
                }
                else if (result.kind === "done")
                    finish({ kind: "done", change: result.change });
                else
                    finish({ kind: result.kind });
            }
            catch (error) {
                finished = true;
                erase();
                cleanup();
                reject(error);
            }
        }
        try {
            emitKeypressEvents(input);
            input.setRawMode?.(true);
            raw = true;
            onExit.on("exit", exitHook);
            for (const signal of SIGNALS) {
                const handler = () => {
                    // The terminal first, THEN the default action: a process killed in raw mode leaves a shell that echoes nothing.
                    if (finished)
                        return;
                    finished = true;
                    erase();
                    cleanup();
                    terminate(signal);
                };
                signalHandlers.set(signal, handler);
                signals.on(signal, handler);
            }
            input.on("keypress", onKey);
            if (typeof output.on === "function")
                output.on("resize", onResize);
            input.resume();
            draw();
        }
        catch (error) {
            finished = true;
            cleanup();
            reject(error);
        }
    });
}
//# sourceMappingURL=picker_checklist.js.map