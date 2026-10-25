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
import { CURSOR, paint, truncateMiddle, wrap } from "./term.js";
const AGENTS = ["claude-code", "codex-cli", "cursor"];
const GAP = 3;
/** `  › [x] ` — a cursor column and a tick box ahead of the name. */
const LEAD = 8;
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
    // The cursor starts on the pre-ticked row when there is one (the working folder's repo), else on the first row.
    const pre = rows.find((r) => (r.kind === "repo" && r.repo.pre) || (r.kind === "off" && r.row.pre));
    return { cursor: (pre ?? rows[0])?.id ?? "", ticked, expanded: new Set() };
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
export function step(model, state, key) {
    const rows = checklistRows(model, state.expanded);
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
                return key.name === "return" ? { kind: "done", change: changeOf(model, state) } : { kind: "state", state };
            if (current.kind === "more") {
                const expanded = new Set(state.expanded).add(current.group.owner);
                return { kind: "state", state: { ...state, expanded } };
            }
            if (key.name === "return")
                return { kind: "done", change: changeOf(model, state) };
            if (isCovered(state, current))
                return { kind: "state", state };
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
    for (const row of model.onNow) {
        if (state.ticked.has(`on:${row.kind}:${row.key}`))
            continue;
        if (row.kind === "owner")
            change.stopOwners.push(row.key);
        else if (row.kind === "repo")
            change.stopRepos.push(row.key);
        else
            change.stopClones.push(row.key);
    }
    for (const group of model.owners) {
        if (state.ticked.has(`all:${group.owner}`)) {
            change.addOwners.push(group.owner);
            continue;
        }
        for (const repo of group.repos)
            if (state.ticked.has(`repo:${repo.slug}`))
                change.addRepos.push(repo.slug);
    }
    for (const row of model.turnedOff)
        if (state.ticked.has(`off:${row.slug}`))
            change.turnOn.push(row.slug);
    return change;
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
/** The frame, as lines. The cursor row is `strong` and marked `›`; no reverse video, no fill (§13.1). */
export function renderFrame(model, state, options) {
    const { colour, nowMs, typedCommand } = options;
    const rows = checklistRows(model, state.expanded);
    // Name column, as the typed screen sizes it.
    const metaOf = (row) => {
        if (row.kind === "on") {
            const r = row.row;
            return r.kind === "owner"
                ? { name: `${r.key}/`, meta: [r.reason, PICKER.ownerOnReposHere(r.reposHere)].join(" · "), agents: "" }
                : { name: r.key, meta: [r.reason, counts(r.counts, nowMs)].filter(Boolean).join(" · "), agents: agents(r.counts) };
        }
        if (row.kind === "repo") {
            const flag = row.repo.here === "repo" ? PICKER.thisRepo : row.repo.here === "folder" ? PICKER.thisFolder : "";
            return {
                name: row.repo.name,
                meta: [counts(row.repo, nowMs), flag].filter(Boolean).join(" · "),
                agents: agents(row.repo),
            };
        }
        if (row.kind === "off")
            return { name: row.row.slug, meta: PICKER.turnOnHint, agents: "" };
        return { name: "", meta: "", agents: "" };
    };
    const named = rows.map((r) => ({ row: r, ...metaOf(r) })).filter((r) => r.name !== "");
    const longestMeta = named.reduce((n, r) => Math.max(n, r.meta.length), 0);
    const longestName = named.reduce((n, r) => Math.max(n, r.name.length), 0);
    const column = Math.max(12, Math.min(longestName, 80 - LEAD - GAP - longestMeta));
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
    const out = [""];
    out.push(...wrap(SCAN.found(model.found), 2).map((l) => paint(colour, "strong", l)));
    out.push(paint(colour, "muted", `  ${PICKER.hint}`));
    out.push(paint(colour, "muted", `  ${PICKER.hintTyped(typedCommand)}`));
    out.push("");
    const seenOwner = new Set();
    let wroteOn = false;
    let wroteOff = false;
    for (const entry of rows) {
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
        else {
            const withAgents = m.agents !== "" && LEAD + column + GAP + m.meta.length + 3 + m.agents.length <= 80
                ? `${m.meta} · ${m.agents}`
                : m.meta;
            out.push(line(entry, `${box(entry)} ${cut(m.name).padEnd(column)}`, `${" ".repeat(GAP)}${withAgents}`));
        }
    }
    out.push(...notListedBlock(model, colour));
    return out;
}
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
function keyOf(str, key) {
    if (key?.ctrl === true && key.name === "c")
        return { name: "ctrl-c" };
    switch (key?.name) {
        case "up":
        case "down":
        case "return":
            return { name: key.name };
        case "space":
            return { name: "space" };
        case "t":
            return { name: "t" };
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
        let state = initChecklist(model);
        let drawn = 0;
        let raw = false;
        let finished = false;
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
            const lines = renderFrame(model, state, options);
            output.write(`${drawn > 0 ? `${CURSOR.up(drawn)}${CURSOR.column1}${CURSOR.clearBelow}` : ""}${lines.join("\n")}\n`);
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
                const result = step(model, state, keyOf(str, key));
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