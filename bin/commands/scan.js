/**
 * `vibecommit scan` — design review D17 · 11A, D33 · 27A; capture 0.7.0, PR 1.
 *
 * Which repositories on this machine has a coding agent been used in? Read-only,
 * no network, and VibeCommit writes no file. (Opening Codex's index `readOnly` makes
 * SQLite create its own `-wal`/`-shm` journal files beside it when Codex has closed
 * them, as any SQLite reader does — measured, PR 1 F1; the index itself is never
 * written.) It is the engine `connect` will use for its
 * picker (`scanMachine`, exported for it, D1) and a public verb in its own right,
 * so an AI agent can list capturable repos without entering a consent flow.
 *
 * ## ⛔ NO TRANSCRIPT IS EVER OPENED
 *
 * The consent design is that no path opens a transcript of a repo nobody granted,
 * and the thing that decides what to OFFER cannot be the thing that reads them.
 * Every count here comes from a directory entry's name or an `lstat`'s time
 * (`SourceSession`), and Codex's from four index columns. A folder is resolved to
 * a path by walking the FILESYSTEM against the folder's encoded name — never by
 * reading the `cwd` a transcript records, which is analysis (D60 §D6). The one
 * ruled exception to that is backfill's one-field check, after consent, and it is
 * not in this file.
 *
 * ## The walk, and why it can say no
 *
 * Both folder-keyed agents encode a path LOSSILY (`/a/b-c`, `/a/b/c` and `/a/b.c`
 * are one name under Claude Code's rule), so a name is not a path. The engine
 * encodes every directory ENTRY with the dialect's own `encodeProjectPath` and
 * keeps those whose encoding is the name, or a prefix of it that ends at a
 * separator — so the collapsing and trimming of Cursor's rule apply to every
 * candidate, and nothing is assumed. The outcomes, each a different count:
 *
 *   - one existing directory         → resolved (a repo if it is a git work tree,
 *                                        else counted as a folder that isn't one)
 *   - two or more                    → ambiguous, skipped
 *   - none                           → the folder no longer exists
 *   - a hashed (cut) name            → cannot be inverted, counted with ambiguous
 *   - one, but the agent's own record names a DELETED path that encodes to the
 *     same name → ambiguous too (the deleted-sibling case; the `projects` map)
 *
 * ## The walk reads each directory once
 *
 * Folders under one directory (a temp directory holding hundreds of project
 * folders) all walk through it, and the first version re-read and re-encoded it for
 * every one of them: 5.7 s of an 8.1 s scan on a machine with 130 folders. Within one
 * `scanMachine` run each directory is read ONCE and its children indexed by their
 * full encoding, so a step down the tree is a hash lookup on the prefixes of the name
 * that end at a `-`, not a pass over every entry.
 *
 * ## Path reuse
 *
 * A transcript last written BEFORE its clone's first reflog entry predates the
 * clone, so it may belong to a different repo that once lived at that path. It is
 * skipped. A clone with no reflog cannot be tested and is reported instead, as one
 * backfill will skip. ⚠ Git facts and a file time only.
 */
import { existsSync, realpathSync } from "node:fs";
import { readEntries } from "../agents/session_listing.js";
import { DIALECTS } from "../agents/registry.js";
import { COMMANDS, SCAN, shortDate } from "../copy/index.js";
import { connectCommandFor } from "../install.js";
import { renderVerbHelp } from "../verb_help.js";
import { normalizeSlug } from "../consent.js";
import { EXIT } from "../exit.js";
import { firstReflogSeconds, gitProbe, resolveRepoSlug } from "../git.js";
import { emitJson } from "../json.js";
import { resolveProjectKeys } from "../project.js";
import { paint, tildePath, truncatePath, wrap } from "../term.js";
import { writeLines } from "./context.js";
/**
 * Finds the existing directories a folder name encodes, memoizing as it goes.
 *
 * ⛔ **Matching is by the dialect's OWN encoder, applied to the whole candidate
 * path.** A directory is a candidate when its path encodes to `name`, and is
 * descended into when that encoding is a proper prefix of `name` followed by the
 * encoded separator `-`. Encoding the whole path (not just the entry) is what
 * makes Cursor's run-collapsing correct across a boundary: `/a/` + `-b` is one
 * dash there, and two under Claude Code's rule.
 *
 * Directories only, and a symlink is not one (`Dirent.isDirectory` is false for
 * it): both agents name the folder from the working directory's REAL path, so a
 * symlinked component can never be part of a name — `/tmp` is `private-tmp`.
 *
 * ## ⚠ Why an index and not a loop over entries
 *
 * A directory's children are keyed by their FULL encoding, once, when it is first
 * read. A step down is then: for each prefix of `name` that ends at a `-` (a handful),
 * look it up. That is exactly the old loop's test (`encoded === name`, or a proper
 * prefix followed by `-`) with the entries pre-bucketed by the answer, so the old
 * cells are its proof. An entry whose encoding is EMPTY (Cursor, a directory named
 * only punctuation) is keyed to its parent's encoding and found through the same
 * lookup; the empty prefix is tried for the root's sake.
 */
function makeWalk(read) {
    // Two caches, because they have different keys: a directory's entries are one fact however many agents
    // walk it, while the encodings of its children are one per dialect.
    const directories = new Map();
    const directoriesOf = (dir) => {
        let names = directories.get(dir);
        if (names === undefined) {
            names = [];
            try {
                for (const entry of read(dir) ?? [])
                    if (entry.isDirectory())
                        names.push(entry.name);
            }
            catch {
                // An unreadable directory has no children we can name; the walk goes on.
            }
            directories.set(dir, names);
        }
        return names;
    };
    const indexes = new Map();
    const indexOf = (dir, encode) => {
        let perDir = indexes.get(encode);
        if (perDir === undefined) {
            perDir = new Map();
            indexes.set(encode, perDir);
        }
        let index = perDir.get(dir);
        if (index === undefined) {
            index = new Map();
            for (const name of directoriesOf(dir)) {
                const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
                const key = encode(path);
                const known = index.get(key);
                if (known === undefined)
                    index.set(key, [path]);
                else
                    known.push(path);
            }
            perDir.set(dir, index);
        }
        return index;
    };
    /** Every existing directory whose encoding is `name`, up to `limit` (2: is there MORE than one?). */
    return (name, encode, limit = 2) => {
        const found = [];
        // The prefixes a parent's encoding can be: everything before a `-`, then the whole name.
        const prefixes = [""];
        for (let i = 1; i < name.length; i += 1)
            if (name[i] === "-")
                prefixes.push(name.slice(0, i));
        prefixes.push(name);
        const visit = (dir) => {
            const index = indexOf(dir, encode);
            for (const prefix of prefixes) {
                for (const path of index.get(prefix) ?? []) {
                    if (found.length >= limit)
                        return;
                    if (prefix === name)
                        found.push(path);
                    else
                        visit(path);
                }
            }
        };
        visit("/");
        return found;
    };
}
function resolveFolder(name, source, find, deleted) {
    if (source.isHashed(name))
        return { kind: "ambiguous" };
    const found = find(name, source.encode);
    if (found.length === 0)
        return { kind: "missing" };
    if (found.length > 1)
        return { kind: "ambiguous" };
    // The agent's own record of a path that encodes to this name but is gone: this
    // folder may be that path's, and the one survivor only a look-alike.
    const deletedSibling = (deleted.get(name) ?? []).some((path) => !existsSync(path));
    return deletedSibling ? { kind: "ambiguous" } : { kind: "resolved", dir: found[0] };
}
function probeTree(top, commonDir) {
    const hooksPath = gitProbe(top, ["config", "--get", "core.hooksPath"])?.trim() ?? "";
    return {
        top,
        commonDir,
        slug: normalizeSlug(resolveRepoSlug(top)),
        firstReflogSec: firstReflogSeconds(top),
        hooksPath: hooksPath === "" ? null : hooksPath,
    };
}
/** The order the agents are shown in, and the keys every count record carries. */
const AGENT_ORDER = DIALECTS.map((dialect) => dialect.id);
function emptyAgents() {
    return { "claude-code": 0, "codex-cli": 0, cursor: 0 };
}
/**
 * Scan this machine. Pure of ambient state: `home` and `env` arrive as data, so a
 * test drives it against a throwaway HOME and never against the developer's own
 * agent stores.
 */
export function scanMachine(home, env, deps = {}) {
    const find = makeWalk(deps.readEntries ?? readEntries);
    let ambiguous = 0;
    let missing = 0;
    let nonRepo = 0;
    let unindexed = 0;
    let reused = 0;
    const unreadable = [];
    const placed = [];
    for (const dialect of DIALECTS) {
        const source = dialect.sessionSource(home, env);
        if (source.kind === "unreadable") {
            unreadable.push({ agent: dialect.id, reason: source.reason });
        }
        else if (source.kind === "rows") {
            unindexed += source.unindexed;
            for (const row of source.rows) {
                // The row's `cwd` is a realpath (measured), so it is compared as one.
                let dir;
                try {
                    dir = realpathSync(row.cwd);
                }
                catch {
                    missing += 1;
                    continue;
                }
                placed.push({ agent: dialect.id, session: row.session, dir });
            }
        }
        else {
            // Recorded paths by their encoding, once, so a folder asks "is there a deleted one for me?" by lookup.
            const deleted = new Map();
            for (const path of source.recorded) {
                const key = source.encode(path);
                deleted.set(key, [...(deleted.get(key) ?? []), path]);
            }
            for (const folder of source.folders) {
                const resolution = resolveFolder(folder.name, source, find, deleted);
                if (resolution.kind === "ambiguous")
                    ambiguous += folder.sessions.length;
                else if (resolution.kind === "missing")
                    missing += folder.sessions.length;
                else {
                    for (const session of folder.sessions) {
                        placed.push({ agent: dialect.id, session, dir: resolution.dir });
                    }
                }
            }
        }
    }
    // A directory that is not inside a git work tree is not a repository, so its sessions are COUNTED
    // and not listed (ruling 5a, "nothing silently dropped"): most of an agent's folders are scratch
    // directories, and a line each would bury the ones that matter.
    const byDir = new Map();
    const byTop = new Map();
    const treeFor = (dir) => {
        if (byDir.has(dir))
            return byDir.get(dir) ?? null;
        const keys = resolveProjectKeys(dir);
        let tree = null;
        if (keys !== null) {
            tree = byTop.get(keys.worktree) ?? probeTree(keys.worktree, keys.consent);
            byTop.set(keys.worktree, tree);
        }
        byDir.set(dir, tree);
        return tree;
    };
    const groups = new Map();
    const noRemoteByCommonDir = new Map();
    const noReflog = new Set();
    for (const { agent, session, dir } of placed) {
        const tree = treeFor(dir);
        if (tree === null) {
            nonRepo += 1;
            continue;
        }
        if (tree.firstReflogSec === null)
            noReflog.add(tree.top);
        else if (Math.floor(session.mtimeMs / 1000) < tree.firstReflogSec) {
            reused += 1;
            continue;
        }
        if (tree.slug.startsWith("local:")) {
            // One entry per repo, not per worktree: the smallest path is the stable pick.
            const known = noRemoteByCommonDir.get(tree.commonDir);
            if (known === undefined || tree.top < known)
                noRemoteByCommonDir.set(tree.commonDir, tree.top);
            continue;
        }
        const at = session.startedMs ?? session.mtimeMs;
        let group = groups.get(tree.slug);
        if (group === undefined) {
            group = {
                slug: tree.slug,
                sessions: 0,
                sinceMs: at,
                latestMs: at,
                agents: emptyAgents(),
                trees: new Map(),
                members: [],
            };
            groups.set(tree.slug, group);
        }
        group.sessions += 1;
        group.sinceMs = Math.min(group.sinceMs, at);
        group.latestMs = Math.max(group.latestMs, at);
        group.agents[agent] += 1;
        group.trees.set(tree.top, tree);
        group.members.push({ agent, session, dir, clone: tree.top, commonDir: tree.commonDir });
    }
    const repos = [...groups.values()]
        .map((group) => ({
        slug: group.slug,
        sessions: group.sessions,
        sinceMs: group.sinceMs,
        latestMs: group.latestMs,
        agents: group.agents,
        clones: [...group.trees.values()]
            .map((tree) => ({ path: tree.top, hooksPath: tree.hooksPath }))
            .sort((a, b) => (a.path < b.path ? -1 : 1)),
        members: group.members,
    }))
        // Most recent session first (the drawn screen), the slug to break a tie so the
        // order is the same on every run.
        .sort((a, b) => b.latestMs - a.latestMs || (a.slug < b.slug ? -1 : 1));
    return {
        repos,
        notListed: {
            noRemote: [...noRemoteByCommonDir.values()].sort(),
            ambiguousSessions: ambiguous,
            missingFolderSessions: missing,
            nonRepoSessions: nonRepo,
            pathReusedSessions: reused,
            noReflogClones: [...noReflog].sort(),
            unindexedSessions: unindexed,
            unreadableAgents: unreadable,
        },
    };
}
/** The words in brackets after an unreadable agent. A plain read failure names no cause. */
const UNREADABLE_CAUSE = {
    "unrecognised index": "unrecognised index",
    "index locked": "index locked",
    unreadable: null,
};
/** The `Not listed here:` lines that apply, in the drawn order. Empty when none do. */
function notListedLines(notListed, home, connectCommand) {
    const lines = [];
    if (notListed.noRemote.length > 0)
        lines.push(SCAN.noRemote(notListed.noRemote.length, connectCommand));
    if (notListed.ambiguousSessions > 0)
        lines.push(SCAN.ambiguous(notListed.ambiguousSessions));
    if (notListed.nonRepoSessions > 0)
        lines.push(SCAN.nonRepo(notListed.nonRepoSessions));
    if (notListed.missingFolderSessions > 0) {
        lines.push(SCAN.missingFolder(notListed.missingFolderSessions));
    }
    if (notListed.pathReusedSessions > 0)
        lines.push(SCAN.pathReused(notListed.pathReusedSessions));
    const clones = notListed.noReflogClones;
    if (clones.length === 1) {
        // Left-cut to leave room for the sentence around it (§13.4); the filename identifies.
        lines.push(SCAN.noReflogOne(truncatePath(tildePath(clones[0], home), 40)));
    }
    else if (clones.length > 1) {
        lines.push(SCAN.noReflogMany(clones.length));
        for (const clone of clones)
            lines.push(`  ${truncatePath(tildePath(clone, home), 70)}`);
    }
    if (notListed.unindexedSessions > 0)
        lines.push(SCAN.unindexed(notListed.unindexedSessions));
    for (const { agent, reason } of notListed.unreadableAgents) {
        lines.push(SCAN.unreadable(SCAN.agent[agent], UNREADABLE_CAUSE[reason]));
    }
    return lines;
}
/**
 * The picker's subset of the `Not listed here:` lines (§10.12): repos with no remote and their fix, folders that can't be
 * matched to one repo, and an agent whose store couldn't be read. The other five are scan-only (§10.13).
 */
export function pickerNotListedLines(notListed, connectCommand) {
    const lines = [];
    if (notListed.noRemote.length > 0)
        lines.push(SCAN.noRemote(notListed.noRemote.length, connectCommand));
    if (notListed.ambiguousSessions > 0)
        lines.push(SCAN.ambiguous(notListed.ambiguousSessions));
    for (const { agent, reason } of notListed.unreadableAgents) {
        lines.push(SCAN.unreadable(SCAN.agent[agent], UNREADABLE_CAUSE[reason]));
    }
    return lines;
}
/** True when the scan saw no session at all, so no line could be listed: the new-laptop screen (VQ, PR 3 addition). */
export function sawNoSession(notListed, home) {
    // Only whether a line exists matters here, never its text, so no command is named.
    return notListedLines(notListed, home, "").length === 0;
}
/** The widest a repo name may be before its counts move to a line of their own. */
const COLUMN_GAP = 3;
const ROW_INDENT = 2;
const SECOND_LINE_INDENT = 4;
/**
 * The screen, as lines. `nowMs` is an argument (`shortDate` needs it) so a golden
 * file pins the clock instead of reading it.
 *
 * SGR roles are the picker table's (D24): `strong` the `Found` line, `text` the
 * repo names and the closing command, `muted` counts, dates, the agent line and the
 * whole `Not listed here:` block. `NO_COLOR` is therefore this output minus the
 * escapes — bold carries the structure and indentation the rest (§13.1).
 */
export function renderScan(result, 
/** `connectCommand` is this install's `connect` (`connectCommandFor`); absent means the CLI's own name. */
options) {
    const { colour, home, nowMs } = options;
    const connectCommand = options.connectCommand ?? COMMANDS.connect;
    const lines = [""];
    const listed = notListedLines(result.notListed, home, connectCommand);
    const block = () => listed.length === 0
        ? []
        : [
            "",
            paint(colour, "muted", `  ${SCAN.notListed}`),
            ...listed.map((line) => paint(colour, "muted", `    ${line}`)),
        ];
    if (result.repos.length === 0) {
        lines.push(...wrap(listed.length === 0 ? SCAN.none : SCAN.noneListable, ROW_INDENT).map((line) => paint(colour, "strong", line)), ...block(), "", `  ${SCAN.noneNext}   ${connectCommand}`);
        return lines;
    }
    lines.push(...wrap(SCAN.found(result.repos.length), ROW_INDENT).map((line) => paint(colour, "strong", line)), "");
    const counts = (repo) => `${SCAN.sessions(repo.sessions)} · ${SCAN.since(shortDate(repo.sinceMs, nowMs))}`;
    // The name column is as wide as the widest name whose counts still fit in 80
    // columns. A longer name is never cut ("full names, no cap"): its counts drop to
    // the line below instead.
    const fits = (repo, width) => ROW_INDENT + width + COLUMN_GAP + counts(repo).length <= 80;
    const column = result.repos
        .filter((repo) => fits(repo, repo.slug.length))
        .reduce((widest, repo) => Math.max(widest, repo.slug.length), 0);
    for (const repo of result.repos) {
        if (repo.slug.length <= column) {
            lines.push(`  ${paint(colour, "text", repo.slug.padEnd(column))}${" ".repeat(COLUMN_GAP)}${paint(colour, "muted", counts(repo))}`);
        }
        else {
            lines.push(`  ${paint(colour, "text", repo.slug)}`, `${" ".repeat(SECOND_LINE_INDENT)}${paint(colour, "muted", counts(repo))}`);
        }
        const agents = AGENT_ORDER.filter((agent) => repo.agents[agent] > 0).map((agent) => `${SCAN.agent[agent]} ${repo.agents[agent]}`);
        lines.push(`${" ".repeat(SECOND_LINE_INDENT)}${paint(colour, "muted", agents.join(" · "))}`);
    }
    lines.push(...block(), "", `  ${SCAN.next}   ${connectCommand}`);
    return lines;
}
/** The `--json` document body — a contract, pinned in `test/json-read-verbs.test.ts`. */
export function scanDocument(result) {
    return {
        repos: result.repos.map((repo) => ({
            slug: repo.slug,
            sessions: repo.sessions,
            since: new Date(repo.sinceMs).toISOString().slice(0, 10),
            agents: { ...repo.agents },
            clones: repo.clones.map((clone) => clone.path),
        })),
        not_listed: {
            no_remote: result.notListed.noRemote,
            ambiguous_sessions: result.notListed.ambiguousSessions,
            missing_folder_sessions: result.notListed.missingFolderSessions,
            non_repo_sessions: result.notListed.nonRepoSessions,
            path_reused_sessions: result.notListed.pathReusedSessions,
            no_reflog_clones: result.notListed.noReflogClones,
            unindexed_sessions: result.notListed.unindexedSessions,
            unreadable_agents: result.notListed.unreadableAgents.map(({ agent, reason }) => ({
                agent,
                reason,
            })),
        },
    };
}
/**
 * `vibecommit scan [--json]`. Exit `0` when a repository was listed, `4` when
 * none was — and `4` is "nothing to report", not an error (DESIGN.md §13.7), so a
 * wrapper can branch on it without parsing copy. It holds even when `Not listed
 * here:` has lines.
 */
export function scan(ctx, argv = [], deps = {}) {
    // Check-first, like every other verb's `--help`: reads and writes nothing.
    if (argv.includes("--help") || argv.includes("-h")) {
        const helpVerb = "scan"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    const json = argv.includes("--json");
    // The beat is one STATIC line, overwritten once with `done` on a terminal (D17);
    // with no terminal or `NO_COLOR` it prints plainly, once, with no overwrite. No
    // spinner (§13.8). `ctx.colour` is false in exactly those cases, and under
    // `--json`, where there is no beat at all.
    const overwrite = ctx.colour && !json;
    const beat = `  ${SCAN.beat}`;
    if (overwrite)
        ctx.stdout.write(`\n${beat}`);
    const result = (deps.scanMachine ?? scanMachine)(ctx.home, ctx.env);
    const code = result.repos.length > 0 ? EXIT.ok : EXIT.empty;
    if (json) {
        emitJson(ctx.stdout, "scan", result.repos.length > 0 ? "found" : "none", scanDocument(result));
        return code;
    }
    const done = `${beat}   ${SCAN.beatDone}`;
    ctx.stdout.write(overwrite ? `\r${done}\n` : `\n${done}\n`);
    writeLines(ctx.stdout, renderScan(result, {
        colour: ctx.colour,
        home: ctx.home,
        nowMs: ctx.now().getTime(),
        connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
    }));
    return code;
}
//# sourceMappingURL=scan.js.map