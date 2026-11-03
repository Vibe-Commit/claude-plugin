/**
 * The `connect` picker — style guide §10.12, design review D5-D35; capture 0.7.0, PR 3.
 *
 * Which repositories does the person want captured? This module is the PURE half: it turns a `scan` result and the
 * grants already on disk into rows, parses what the person types, renders the typed screen and the `You chose:` block,
 * and says what a choice changes. It reads no file, opens no transcript and writes nothing — `connect` supplies the
 * facts and applies the change, and `picker_checklist.ts` is the arrow-key driver over the same model.
 *
 * ## What the rows are
 *
 *   on now      grants and per-clone consents that are already admitting capture. REMOVABLE (D31): unticking one, or
 *               typing `-N`, deletes the grant. It is not an exclusion (`off` is), so the repo can be chosen again.
 *   owners      one group per owner NOT yet granted, its repos behind an `aN` "all, including repos you clone later"
 *               row (D9: at most 8 repos before `+ N more`).
 *   folders     (any-folder capture, R3) folders outside every work tree that hold sessions, one `Folders` group. A folder grant
 *               captures the sessions there that touch no repository, under a `local:folder:` identity that only the uploader
 *               can read; its grant line SAYS so ("private to you", R7). Granted folders are `on now` rows, removable like any.
 *   turned off  slugs in `excluded`. Choosing one is a re-include; the grant block names it on a `turn on` row, inside
 *               the same y/N (D7 · 3A), and only a yes clears the exclusion.
 *   on your account  (slice 2) what the account grants that this machine has not named. Unticked until chosen, like any
 *               row: choosing one is an ordinary addition, so it goes through the same disclosure and y/N (R3-8, R3-9).
 *
 * ⛔ **A pre-tick is not a consent** (D34): the working folder's repo starts ticked, and Enter on it leads to the naming
 * y/N, which defaults to N. It is an ADDITION to the diff, never part of the baseline.
 */
import { ownerOfSlug, normalizeSlug, normalizeOwner, isLocalSlug } from "./consent.js";
import { AGENT_HOOKS, SCAN, PICKER, shortDate } from "./copy/index.js";
import { DIALECTS, agentIsolatesRecords } from "./agents/registry.js";
import { LABEL_GUTTER, paint, truncateMiddle, wrap } from "./term.js";
/** D9: each owner group shows at most this many repos before the `+ N more` row. */
export const GROUP_CAP = 8;
/** The gap between the name column and the counts, as `scan`'s screen has it. */
const GAP = 3;
/** The width of the lead before a name: a right-aligned number and two spaces, or a cursor and a tick box. */
const LEAD = 8;
const AGENT_ORDER = ["claude-code", "codex-cli", "cursor"];
export const NO_CHANGE = {
    addOwners: [],
    addRepos: [],
    turnOn: [],
    stopOwners: [],
    stopRepos: [],
    stopClones: [],
};
export function isNoChange(change) {
    return (change.addOwners.length === 0 &&
        change.addRepos.length === 0 &&
        change.turnOn.length === 0 &&
        change.stopOwners.length === 0 &&
        change.stopRepos.length === 0 &&
        change.stopClones.length === 0 &&
        (change.addFolders ?? []).length === 0 &&
        (change.stopFolders ?? []).length === 0);
}
/**
 * What Enter means when the working folder's repo is pre-selected (D34): choosing it, which leads to the y/N and never to
 * a grant. `null` when nothing is pre-selected, where Enter changes nothing (D5).
 */
export function preChange(model) {
    const repo = model.owners.flatMap((g) => g.repos).find((r) => r.pre);
    if (repo !== undefined)
        return { ...NO_CHANGE, addRepos: [repo.slug] };
    const off = model.turnedOff.find((r) => r.pre);
    return off === undefined ? null : { ...NO_CHANGE, turnOn: [off.slug] };
}
/** Anything the person is ADDING needs the D65 disclosure; removals alone do not. */
export function hasAdditions(change) {
    return change.addOwners.length + change.addRepos.length + change.turnOn.length + (change.addFolders ?? []).length > 0;
}
/**
 * The folder as a FOLDER GRANT would capture it (C34): only the sessions of agents whose records can be isolated count, because a
 * Cursor session (or a Codex one, until its isolation lands) under a granted folder is never captured, and a count or an offer that
 * included it would promise what does not happen. `null` when no session passes. Times and counts are recomputed from the members
 * when the scan kept them; a hand-built folder without members keeps its own times and zeroes the agents that fail.
 */
export function capturableFolder(folder, isolates = agentIsolatesRecords) {
    const agents = emptyAgents();
    if (folder.members !== undefined) {
        const kept = folder.members.filter((member) => isolates(member.agent));
        if (kept.length === 0)
            return null;
        let sinceMs = Infinity;
        let latestMs = 0;
        for (const member of kept) {
            const at = member.session.startedMs ?? member.session.mtimeMs;
            sinceMs = Math.min(sinceMs, at);
            latestMs = Math.max(latestMs, at);
            agents[member.agent] += 1;
        }
        return { path: folder.path, sessions: kept.length, sinceMs, latestMs, agents, members: kept };
    }
    let sessions = 0;
    for (const agent of Object.keys(agents)) {
        if (isolates(agent)) {
            agents[agent] = folder.agents[agent] ?? 0;
            sessions += agents[agent];
        }
    }
    return sessions === 0 ? null : { path: folder.path, sessions, sinceMs: folder.sinceMs, latestMs: folder.latestMs, agents };
}
/**
 * The agents a folder grant captures, as the copy names them: `Claude Code`, `Claude Code or Codex`, `Claude Code, Codex or Cursor`.
 * Built from the same predicate as the offers (C34), so the sentence and the behaviour cannot disagree.
 */
export function folderCaptureAgents(isolates = agentIsolatesRecords) {
    const names = DIALECTS.filter((dialect) => isolates(dialect.id)).map((dialect) => SCAN.agent[dialect.id]);
    if (names.length <= 1)
        return names.join("");
    return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}
function splitSlug(slug) {
    const owner = ownerOfSlug(slug);
    return { owner, name: owner === "" ? slug : slug.slice(owner.length + 1) };
}
function emptyAgents() {
    return { "claude-code": 0, "codex-cli": 0, cursor: 0 };
}
export function buildModel(input) {
    const { grants } = input;
    const excluded = new Set(grants.excluded);
    const coveredByGrant = (slug) => grants.repos.includes(slug) || grants.owners.includes(ownerOfSlug(slug));
    const repos = new Map();
    for (const repo of input.repos) {
        const slug = normalizeSlug(repo.slug);
        const { owner, name } = splitSlug(slug);
        repos.set(slug, {
            slug,
            owner,
            name,
            sessions: repo.sessions,
            sinceMs: repo.sinceMs,
            latestMs: repo.latestMs,
            agents: repo.agents,
            clones: repo.clones,
            here: null,
            pre: false,
        });
    }
    // This repo's row comes from the working folder, not the scan: a repo no agent has run in yet still appears (D34).
    if (input.here !== null) {
        const slug = normalizeSlug(input.here.slug);
        const found = repos.get(slug);
        const { owner, name } = splitSlug(slug);
        const base = found ?? {
            slug,
            owner,
            name,
            sessions: 0,
            sinceMs: 0,
            latestMs: 0,
            agents: emptyAgents(),
            clones: [{ path: input.here.toplevel, hooksPath: null }],
            here: null,
            pre: false,
        };
        repos.set(slug, { ...base, here: input.here.kind, pre: input.here.kind === "repo" });
    }
    const perCloneSlugs = new Map();
    for (const entry of input.perClone) {
        if (entry.slug === null)
            continue;
        const slug = normalizeSlug(entry.slug);
        if (isLocalSlug(slug))
            continue;
        perCloneSlugs.set(slug, [...(perCloneSlugs.get(slug) ?? []), entry.commonDir]);
    }
    const countsOf = (slug) => {
        const r = repos.get(slug);
        return r === undefined || r.sessions === 0 ? null : r;
    };
    const onNow = [];
    for (const owner of grants.owners) {
        const reposHere = [...repos.values()].filter((r) => r.owner === owner).length;
        onNow.push({ kind: "owner", key: owner, reason: PICKER.reasonOwner, counts: null, reposHere, commonDirs: [] });
    }
    for (const slug of grants.repos) {
        if (excluded.has(slug) || grants.owners.includes(ownerOfSlug(slug)))
            continue;
        onNow.push({ kind: "repo", key: slug, reason: PICKER.reasonRepo, counts: countsOf(slug), reposHere: 0, commonDirs: [] });
    }
    for (const [slug, commonDirs] of perCloneSlugs) {
        if (excluded.has(slug) || coveredByGrant(slug))
            continue;
        onNow.push({ kind: "clone", key: slug, reason: PICKER.reasonPerClone, counts: countsOf(slug), reposHere: 0, commonDirs });
    }
    // Folder grants (R3): a granted folder is an `on now` row (removable); every other folder with sessions is offered.
    const folderLabel = input.folderLabel ?? ((path) => path);
    const grantedFolders = new Set(input.grantedFolders ?? []);
    // ⛔ C34: counts and offers cover only what a folder grant would capture. A folder with no passing session is not offered; a granted
    // one stays a removable `on now` row, with no counts.
    const isolates = input.isolates ?? agentIsolatesRecords;
    const capturable = (input.folders ?? []).flatMap((folder) => {
        const kept = capturableFolder(folder, isolates);
        return kept === null ? [] : [kept];
    });
    const folderCounts = new Map(capturable.map((folder) => [folder.path, folder]));
    for (const path of input.grantedFolders ?? []) {
        onNow.push({ kind: "folder", key: path, label: folderLabel(path), reason: PICKER.reasonFolder, counts: folderCounts.get(path) ?? null, reposHere: 0, commonDirs: [] });
    }
    const excludedSet = new Set(input.excludedFolders ?? []);
    const offered = capturable.filter((folder) => !grantedFolders.has(folder.path));
    const folders = [
        ...offered.map((folder) => ({
            path: folder.path,
            label: folderLabel(folder.path),
            sessions: folder.sessions,
            sinceMs: folder.sinceMs,
            latestMs: folder.latestMs,
            agents: folder.agents,
            ...(excludedSet.has(folder.path) ? { excluded: true } : {}),
        })),
        // A folder turned off that no scan found any more is still a row, so it can be turned back on.
        ...[...excludedSet]
            .filter((path) => !offered.some((folder) => folder.path === path))
            .map((path) => ({ path, label: folderLabel(path), sessions: 0, sinceMs: 0, latestMs: 0, agents: emptyAgents(), excluded: true })),
    ];
    const isOn = (slug) => coveredByGrant(slug) || perCloneSlugs.has(slug);
    const byOwner = new Map();
    for (const repo of repos.values()) {
        if (excluded.has(repo.slug) || isOn(repo.slug))
            continue;
        byOwner.set(repo.owner, [...(byOwner.get(repo.owner) ?? []), repo]);
    }
    const groups = [...byOwner.entries()]
        .map(([owner, list]) => ({
        owner,
        list: [...list].sort((a, b) => b.latestMs - a.latestMs || (a.slug < b.slug ? -1 : 1)),
    }))
        .sort((a, b) => b.list[0].latestMs - a.list[0].latestMs || (a.owner < b.owner ? -1 : 1));
    const owners = groups.map((g, i) => ({ owner: g.owner, token: `a${i + 1}`, repos: g.list }));
    const hereSlug = input.here?.kind === "repo" ? normalizeSlug(input.here.slug) : null;
    const turnedOff = [...excluded]
        .sort()
        .map((slug) => ({ slug, counts: countsOf(slug), pre: slug === hereSlug }));
    // ⛔ THE SCAN ROW WINS: an owner that already has a group above, and a repo already listed under one, are not repeated under "on
    // your account" — choosing the scan row is the same change, and one row per thing is what a person can read.
    const shownOwners = new Set(owners.map((group) => group.owner));
    const shownRepos = new Set(owners.flatMap((group) => group.repos.map((repo) => repo.slug)));
    const account = (input.accountNotHere ?? [])
        .map((name) => name.endsWith("/")
        ? { kind: "owner", key: normalizeOwner(name.slice(0, -1)) }
        : { kind: "repo", key: normalizeSlug(name) })
        .filter((row) => (row.kind === "owner" ? !shownOwners.has(row.key) : !shownRepos.has(row.key)));
    return {
        onNow,
        owners,
        account,
        turnedOff,
        folders,
        notListed: input.notListed,
        found: input.repos.length,
        sawNothing: input.sawNothing,
    };
}
/**
 * The numbered rows in screen order. `showAll` is the `more` token: every repo is shown and numbered afresh. Without it
 * each owner shows `GROUP_CAP` repos and the rest are reachable only by typing `owner/repo` or `more`.
 */
export function numberedRows(model, showAll) {
    const rows = model.onNow.map((row) => ({ kind: "on", row }));
    for (const group of model.owners) {
        const shown = showAll ? group.repos : group.repos.slice(0, GROUP_CAP);
        for (const repo of shown)
            rows.push({ kind: "repo", repo });
    }
    for (const folder of showAll ? model.folders : model.folders.slice(0, GROUP_CAP))
        rows.push({ kind: "folder", folder });
    for (const row of model.account)
        rows.push({ kind: "account", row });
    for (const row of model.turnedOff)
        rows.push({ kind: "off", row });
    return rows;
}
const OWNER_TOKEN = /^[^\s/]+(?:\/[^\s/]+)*\/$/u;
const REPO_TOKEN = /^[^\s/]+(?:\/[^\s/]+)*\/[^\s/]+$/u;
/**
 * Parse one typed answer (D8 · 4A). ⛔ **Never applies part of an answer:** any token that is not understood returns
 * `error` naming each such token, and nothing is chosen. `owner/` and `owner/repo` are always accepted, a clone here or
 * not, because a new laptop needs them; the grant block flags `(no clone here yet)`.
 *
 * ⛔ **`g` STANDS ALONE** (exception 3, R3-12): where `offerAccount` is true, `g` alone is the account's grants, and `g` mixed with
 * any other token is refused with nothing applied, so the y/N after it always names a single list. Where it was not offered `g` is
 * an ordinary token nobody understands.
 */
export function parseTyped(input, model, showAll, offerAccount = false) {
    const tokens = input.split(/[\s,]+/u).filter((t) => t !== "");
    if (tokens.length === 0)
        return { kind: "empty" };
    if (tokens.length === 1 && tokens[0].toLowerCase() === "more")
        return { kind: "more" };
    if (offerAccount && tokens.some((t) => t.toLowerCase() === "g")) {
        return tokens.length === 1 ? { kind: "account" } : { kind: "error", tokens: [PICKER.gMixedToken] };
    }
    const rows = numberedRows(model, showAll);
    const bad = [];
    const addOwners = new Set();
    const addRepos = new Set();
    const turnOn = new Set();
    const stopOwners = new Set();
    const stopRepos = new Set();
    const stopClones = new Set();
    const addFolders = new Set();
    const stopFolders = new Set();
    const grantedOwners = new Set(model.onNow.filter((r) => r.kind === "owner").map((r) => r.key));
    const grantedRepos = new Set(model.onNow.filter((r) => r.kind === "repo").map((r) => r.key));
    const cloneSlugs = new Set(model.onNow.filter((r) => r.kind === "clone").map((r) => r.key));
    const offSlugs = new Set(model.turnedOff.map((r) => r.slug));
    const stop = (row) => {
        if (row.kind === "owner")
            stopOwners.add(row.key);
        else if (row.kind === "repo")
            stopRepos.add(row.key);
        else if (row.kind === "folder")
            stopFolders.add(row.key);
        else
            stopClones.add(row.key);
    };
    const addSlug = (slug, token) => {
        if (offSlugs.has(slug))
            turnOn.add(slug);
        else if (grantedRepos.has(slug) || cloneSlugs.has(slug) || grantedOwners.has(ownerOfSlug(slug))) {
            bad.push(PICKER.alreadyOn(token, `-${token}`));
        }
        else
            addRepos.add(slug);
    };
    for (const token of tokens) {
        const owner = /^a(\d+)$/iu.exec(token);
        const remove = token.startsWith("-") && token.length > 1 ? token.slice(1) : null;
        if (owner !== null) {
            const group = model.owners.find((g) => g.token === `a${Number(owner[1])}`);
            if (group === undefined)
                bad.push(PICKER.noRow(token));
            else
                addOwners.add(normalizeOwner(group.owner));
        }
        else if (/^\d+$/u.test(token)) {
            const row = rows[Number(token) - 1];
            if (row === undefined)
                bad.push(PICKER.noRow(token));
            else if (row.kind === "on")
                bad.push(PICKER.alreadyOn(token, `-${token}`));
            else if (row.kind === "off")
                turnOn.add(row.row.slug);
            else if (row.kind === "folder")
                addFolders.add(row.folder.path);
            else if (row.kind === "account") {
                if (row.row.kind === "owner")
                    addOwners.add(row.row.key);
                else
                    addSlug(row.row.key, token);
            }
            else
                addSlug(row.repo.slug, token);
        }
        else if (remove !== null) {
            const n = /^\d+$/u.test(remove) ? rows[Number(remove) - 1] : undefined;
            if (/^\d+$/u.test(remove)) {
                if (n === undefined)
                    bad.push(PICKER.noRow(remove));
                else if (n.kind === "on")
                    stop(n.row);
                else
                    bad.push(PICKER.notOn(token));
            }
            else if (OWNER_TOKEN.test(remove)) {
                const name = normalizeOwner(remove);
                if (grantedOwners.has(name))
                    stopOwners.add(name);
                else
                    bad.push(PICKER.notOn(token));
            }
            else if (REPO_TOKEN.test(remove)) {
                const name = normalizeSlug(remove);
                if (grantedRepos.has(name))
                    stopRepos.add(name);
                else if (cloneSlugs.has(name))
                    stopClones.add(name);
                else
                    bad.push(PICKER.notOn(token));
            }
            else
                bad.push(token);
        }
        else if (OWNER_TOKEN.test(token)) {
            const name = normalizeOwner(token);
            if (grantedOwners.has(name))
                bad.push(PICKER.alreadyOn(token, `-${token}`));
            else
                addOwners.add(name);
        }
        else if (REPO_TOKEN.test(token)) {
            addSlug(normalizeSlug(token), token);
        }
        else
            bad.push(token);
    }
    if (bad.length > 0)
        return { kind: "error", tokens: bad };
    // Typed owners/repos with no clone on this machine are accepted and flagged in the grant block.
    const known = new Set(model.owners.map((g) => normalizeOwner(g.owner)));
    const knownRepos = new Set(model.owners.flatMap((g) => g.repos.map((r) => r.slug)));
    const noClone = [
        ...[...addOwners].filter((o) => !known.has(o) && !model.onNow.some((r) => r.kind === "owner" && r.key === o)).map((o) => `${o}/`),
        ...[...addRepos].filter((r) => !knownRepos.has(r)),
    ];
    return {
        kind: "change",
        noClone,
        change: {
            addOwners: [...addOwners],
            addRepos: [...addRepos].filter((slug) => ![...addOwners].includes(ownerOfSlug(slug))),
            turnOn: [...turnOn],
            stopOwners: [...stopOwners],
            stopRepos: [...stopRepos],
            stopClones: [...stopClones],
            // Present only when something was chosen, so a repo-only answer is the object it always was.
            ...(addFolders.size > 0 ? { addFolders: [...addFolders] } : {}),
            ...(stopFolders.size > 0 ? { stopFolders: [...stopFolders] } : {}),
        },
    };
}
function countsText(counts, nowMs) {
    if (counts === null)
        return "";
    return `${SCAN.sessions(counts.sessions)} · ${SCAN.since(shortDate(counts.sinceMs, nowMs))}`;
}
function agentsText(counts) {
    if (counts === null)
        return "";
    const used = AGENT_ORDER.filter((agent) => counts.agents[agent] > 0);
    return used.length > 1 ? used.map((agent) => SCAN.agent[agent]).join(", ") : "";
}
function joinMeta(...parts) {
    return parts.filter((p) => p !== "").join(" · ");
}
function onNowDisplay(row, nowMs) {
    if (row.kind === "owner") {
        return { name: `${row.key}/`, meta: joinMeta(row.reason, PICKER.ownerOnReposHere(row.reposHere)), agents: "" };
    }
    return {
        name: row.kind === "folder" ? (row.label ?? row.key) : row.key,
        meta: joinMeta(row.reason, countsText(row.counts, nowMs)),
        agents: agentsText(row.counts),
    };
}
function folderDisplay(folder, nowMs) {
    const counts = folder.sessions === 0 ? null : folder;
    return {
        name: folder.label,
        meta: joinMeta(folder.excluded === true ? PICKER.turnOnHint : "", countsText(counts, nowMs)),
        agents: agentsText(counts),
    };
}
function repoDisplay(repo, nowMs) {
    const flag = repo.here === "repo" ? PICKER.thisRepo : repo.here === "folder" ? PICKER.thisFolder : "";
    return {
        name: repo.name,
        meta: joinMeta(countsText(repo.sessions === 0 ? null : repo, nowMs), flag),
        agents: agentsText(repo.sessions === 0 ? null : repo),
    };
}
/**
 * The name column and the cut names (D27 · 21A). A name is cut in the MIDDLE to the widest column whose counts still fit
 * in 80 columns; the agent-names suffix is dropped before any name is cut; an owner is never cut (it is in the group
 * heading, and an on-now/turned-off row keeps its owner and cuts only the repo part).
 */
function layout(rows) {
    const longestMeta = rows.reduce((n, r) => Math.max(n, r.meta.length), 0);
    const longestName = rows.reduce((n, r) => Math.max(n, r.name.length), 0);
    const room = 80 - LEAD - GAP - longestMeta;
    const column = Math.max(12, Math.min(longestName, room));
    const cut = (name) => {
        if (name.length <= column)
            return name;
        const slash = name.lastIndexOf("/");
        if (slash >= 0 && slash + 1 < column) {
            return `${name.slice(0, slash + 1)}${truncateMiddle(name.slice(slash + 1), column - slash - 1)}`;
        }
        return truncateMiddle(name, column);
    };
    const withAgents = (row) => row.agents !== "" && LEAD + column + GAP + row.meta.length + 3 + row.agents.length <= 80
        ? `${row.meta} · ${row.agents}`
        : row.meta;
    return { column, cut, withAgents };
}
/** `  alexvibecommit/    a1  all 3 repos here, including repos you clone later` */
function ownerLine(group, colour) {
    return `  ${paint(colour, "text", `${group.owner}/`)}    ${paint(colour, "text", group.token)}  ${paint(colour, "text", PICKER.ownerAll(group.repos.length))}`;
}
/** The `Not listed here:` block, muted, or nothing. */
export function notListedBlock(model, colour) {
    if (model.notListed.length === 0)
        return [];
    return [
        "",
        paint(colour, "muted", `  ${SCAN.notListed}`),
        ...model.notListed.map((line) => paint(colour, "muted", `    ${line}`)),
    ];
}
/** The screen above the prompt, as lines — the typed picker (§10.12 "The picker, typed"). */
export function renderTyped(model, options) {
    const { colour, nowMs, showAll } = options;
    const lines = [""];
    if (model.found === 0 &&
        model.onNow.length === 0 &&
        model.turnedOff.length === 0 &&
        model.owners.length === 0 &&
        model.folders.length === 0 &&
        model.account.length === 0) {
        return [
            ...lines,
            ...wrap(model.sawNothing ? PICKER.emptyNone : SCAN.noneListable, 2).map((l) => paint(colour, "strong", l)),
            ...(model.sawNothing ? [...wrap(PICKER.emptyExpected, 2), ...wrap(AGENT_HOOKS.codexTrust, 2)] : []),
            ...notListedBlock(model, colour),
            "",
            ...wrap(model.sawNothing ? PICKER.emptyType : PICKER.emptyListable, 2),
            ...(options.offerAccount === true ? wrap(PICKER.gLine, 2) : []),
            `  ${PICKER.enterNothing}`,
        ];
    }
    lines.push(...wrap(SCAN.found(model.found), 2).map((l) => paint(colour, "strong", l)), "");
    const onNow = model.onNow.map((row) => onNowDisplay(row, nowMs));
    const shown = (g) => (showAll ? g.repos : g.repos.slice(0, GROUP_CAP));
    const repoRows = model.owners.flatMap((g) => shown(g).map((r) => repoDisplay(r, nowMs)));
    const shownFolders = showAll ? model.folders : model.folders.slice(0, GROUP_CAP);
    const folderRows = shownFolders.map((f) => folderDisplay(f, nowMs));
    const account = model.account.map((row) => ({
        name: row.kind === "owner" ? `${row.key}/` : row.key,
        meta: PICKER.onAccountHint,
        agents: "",
    }));
    const off = model.turnedOff.map((row) => ({
        name: row.slug,
        meta: PICKER.turnOnHint,
        agents: "",
    }));
    const { cut, column, withAgents } = layout([...onNow, ...repoRows, ...folderRows, ...account, ...off]);
    const row = (n, display) => `${String(n).padStart(6)}  ${paint(colour, "text", cut(display.name).padEnd(column))}${" ".repeat(GAP)}${paint(colour, "muted", withAgents(display))}`;
    let n = 0;
    if (model.onNow.length > 0) {
        lines.push(paint(colour, "muted", `  ${PICKER.onNow}`));
        for (const d of onNow)
            lines.push(row(++n, d));
    }
    for (const group of model.owners) {
        lines.push(ownerLine(group, colour));
        for (const repo of shown(group))
            lines.push(row(++n, repoDisplay(repo, nowMs)));
        const hidden = group.repos.length - shown(group).length;
        if (hidden > 0) {
            lines.push(paint(colour, "muted", `     +  ${PICKER.moreTyped(hidden, group.owner)}`));
        }
    }
    if (folderRows.length > 0) {
        lines.push(paint(colour, "muted", `  ${PICKER.folders}`));
        for (const d of folderRows)
            lines.push(row(++n, d));
        const hiddenFolders = model.folders.length - shownFolders.length;
        if (hiddenFolders > 0)
            lines.push(paint(colour, "muted", `     +  ${PICKER.moreFoldersTyped(hiddenFolders)}`));
    }
    if (account.length > 0) {
        lines.push(paint(colour, "muted", `  ${PICKER.onAccount}`));
        for (const d of account)
            lines.push(row(++n, d));
    }
    if (model.turnedOff.length > 0) {
        lines.push(paint(colour, "muted", `  ${PICKER.turnedOff}`));
        for (const d of off)
            lines.push(row(++n, d));
    }
    lines.push(...notListedBlock(model, colour), "");
    lines.push(`  ${paint(colour, "text", PICKER.choose(model.owners.length > 0))}`);
    if (options.offerAccount === true)
        lines.push(...wrap(PICKER.gLine, 2).map((l) => paint(colour, "text", l)));
    if (model.onNow.length > 0)
        lines.push(`  ${paint(colour, "text", PICKER.removeHint)}`);
    const pre = preChange(model);
    const preSlug = pre === null ? null : (pre.addRepos[0] ?? pre.turnOn[0] ?? null);
    lines.push(`  ${paint(colour, "text", preSlug === null ? PICKER.enterNothing : PICKER.enterThisRepo(preSlug))}`);
    return lines;
}
/** The `Not understood:` line the prompt prints before it asks again. */
export function notUnderstoodLines(tokens) {
    return wrap(PICKER.notUnderstood(tokens.join(", ")), 2);
}
/**
 * The `You chose:` block — the thing the y/N is asking about (D7 · 3A), on the §13.5 label gutter. One label per kind of
 * change; an owner row says how many repos are here and that later clones are covered, and a typed name with no clone
 * on this machine says so, so a typo shows BEFORE the question.
 */
export function renderGrantBlock(change, facts, colour, 
/** `You chose:` for the person's picks; the account's own list (`g`, screen 1b) is headed `Your account grants:`. */
heading = PICKER.chose) {
    const lines = [`  ${paint(colour, "strong", heading)}`];
    const rows = [
        [
            PICKER.labelOwners,
            change.addOwners.map((o) => {
                const here = facts.reposHere.get(o) ?? 0;
                return `${o}/  ${here > 0 ? PICKER.ownerHere(here) : PICKER.noCloneHere}`;
            }),
        ],
        [
            PICKER.labelRepos,
            change.addRepos.map((r) => (facts.noClone.has(r) ? `${r}  ${PICKER.noCloneHere}` : r)),
        ],
        [
            PICKER.labelTurnOn,
            change.turnOn.map((slug) => (facts.accountOff?.has(slug) === true ? `${slug}  ${PICKER.turnedOffOnAccount}` : slug)),
        ],
        // ⛔ THE FOLDER GRANT LINE SAYS WHO CAN READ IT (R7 · D9): the server makes a folder repository private to its uploader, and the
        // person is told so at the one moment they are asked. Nothing here claims more than that.
        [
            PICKER.labelFolders,
            (change.addFolders ?? []).map((path) => `${facts.folderLabels?.get(path) ?? path}  ${PICKER.folderPrivate}`),
        ],
        [
            PICKER.labelStop,
            [
                ...change.stopOwners.map((o) => `${o}/`),
                ...change.stopRepos,
                ...change.stopClones,
                ...(change.stopFolders ?? []).map((path) => facts.folderLabels?.get(path) ?? path),
            ],
        ],
    ];
    for (const [label, values] of rows) {
        values.forEach((value, i) => {
            const key = i === 0 ? label.padEnd(LABEL_GUTTER) : " ".repeat(LABEL_GUTTER);
            lines.push(`    ${paint(colour, "muted", key)}${paint(colour, "text", value)}`);
        });
    }
    return lines;
}
/** The grant y/N: additions (with or without removals) get the upload question, removals alone the stop question. */
export function grantQuestion(change, colour, answers) {
    const folders = (change.addFolders ?? []).length > 0 || (change.stopFolders ?? []).length > 0;
    const repos = change.addOwners.length + change.addRepos.length + change.turnOn.length + change.stopOwners.length + change.stopRepos.length + change.stopClones.length > 0;
    const q = hasAdditions(change)
        ? folders
            ? repos ? PICKER.questionGrantMixed : PICKER.questionGrantFolders
            : PICKER.questionGrant
        : folders
            ? repos ? PICKER.questionStopMixed : PICKER.questionStopFolders
            : PICKER.questionStop;
    return `  ${paint(colour, "text", q)} ${paint(colour, "muted", answers)} `;
}
//# sourceMappingURL=picker.js.map