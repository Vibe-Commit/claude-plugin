/**
 * `vibecommit backfill` — style guide §10.14, design review D14 · 8A, D15 · 9A; capture 0.7.0, PR 5.
 *
 * Claude Code keeps about 30 days of transcripts and then deletes them. This uploads the ones still on this machine,
 * for the repositories the user chose, once they say yes — and says plainly that a backfilled session arrives WITHOUT
 * commit links. It is offered by `connect` (`backfillForConnect`, for its seam) and is a verb in its own right.
 *
 * ## What it is made of
 *
 * - **Which sessions** come from the scan engine (`scanMachine`): folder names and Codex's index, no transcript opened.
 *   Only repos the consent gate admits (`isCaptureAllowed`) are offered, and only sessions with unsent bytes. A session in
 *   a clone with no reflog, over the 50 MiB cap, or from Cursor is left OUT of the count and named in a muted line, so the
 *   offer never promises an upload the run would skip.
 * - **How one is sent** is `closeSession` (the code `finalize` runs): sub-agent streams first, then the main stream, then
 *   — only for a session quiet for 30 minutes — the seal. Through `deliver()` with `byHook: false`, each clone's own
 *   confinement roots, and the hooks' own offset ledger, so a re-run sends only what is new.
 * - **Each session goes through its OWN agent's dialect** (transport, redaction profile, confinement root); the file is
 *   admitted only if it lies under that agent's transcript root (`admitsTranscript`), which for Codex is
 *   `~/.codex/sessions`.
 * - **The consent gate runs again before EACH session.** The offer is a plan; `vibecommit off` in another terminal during a
 *   long run must stop the rest of that repo, so `uploadOne` asks `isCaptureAllowed` first.
 *
 * ## ⛔ The one transcript read before an upload (exception 1)
 *
 * Alexander ruled (2026-10-24 10:53 EST) that the deleted-sibling case — a folder whose original path is gone and whose
 * encoded name now resolves to a different surviving repo — is CLOSED, not accepted. So, after both the grant y/N and the
 * backfill y/N, one session at a time just before its upload, a Claude Code session has ONE value read from its
 * transcript: the `cwd` of the first record that carries one (`firstRecordedCwd`). It uploads only if that path is
 * absolute, exists, is a git work tree, and is the same clone (common dir) the folder was matched to. This is an exception
 * to D60 §D6 (the client may display transcripts but not analyze them), and it is the ONLY one: the scan, the picker and
 * the offer open no transcript, and nothing else is read from this one. Codex needs no check (its index already holds the
 * real `cwd`). Cursor records no folder at all (measured, STATIC), so its sessions are never uploaded and are counted instead.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { admitsTranscript, agentIsolatesRecords, DIALECTS } from "../agents/registry.js";
import { BACKFILL, COMMANDS, SCAN, URLS, shortDate } from "../copy/index.js";
import { captureStanding, grantsUnreadable, hasAnyConsent, isCaptureAllowed } from "../consent.js";
import { folderStandingOf } from "../folder_grants.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { firstReflogSeconds, onceStrictRepoSlug } from "../git.js";
import { FOLDER_REPOSITORY_FORBIDDEN } from "../policy.js";
import { CAPTURE_NOT_APPROVED, ingestUrl } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { TOP_LEVEL_CWD_ONLY, findSubagentTranscriptsChecked, groupKey, loadTargetRecord, scanTranscriptKeys, stopKeyOf, stopTarget } from "../session_targets.js";
import { SESSION_LIVE_WINDOW_MS } from "../spool.js";
import { fileState, loadSessionState } from "../state.js";
import { glyph, paint, renderErrorBlock, tildePath, truncateMiddle, truncatePath, wrap, WRAP_COLUMNS } from "../term.js";
import { writeLines } from "./context.js";
import { credentialProblem } from "./credential_problem.js";
import { authCommandFor, channelCommand, connectCommandFor } from "../install.js";
import { identityDigest } from "../identity.js";
import { closeSession, closeSpecOf, ingestUrlUnavailableBlock, resolveSessionTargets } from "./finalize.js";
import { scanMachine } from "./scan.js";
import { renderVerbHelp } from "../verb_help.js";
/** A transcript larger than this on disk is not offered (the 50 MiB policy cap). Sub-agent streams are not capped. */
const MAX_SESSION_BYTES = 50 * 1024 * 1024;
/** How long a repo's upload runs before the static `…` line appears (§10.14: "over 4 s"). */
const SLOW_REPO_MS = 4_000;
/** The folder check gives up on a transcript that records no `cwd` in its first few MiB. Fails closed. */
const FOLDER_CHECK_MAX_BYTES = 4 * 1024 * 1024;
/** The widest a repo name is drawn before it is cut in the middle (D27). */
const SLUG_MAX = 36;
const ROW_INDENT = 4;
const FOLDER_INDENT = 6;
const COLUMN_GAP = 3;
/** The least a folder path is cut to, so a very wide agents column never leaves it a stub. */
const PATH_MIN = 12;
// ---------------------------------------------------------------------------
// Which sessions
// ---------------------------------------------------------------------------
/** The session id the agent's own hook would report for this file, so the offset ledger is the same one. */
function sessionIdOf(agent, path) {
    const stem = basename(path, ".jsonl");
    if (agent === "codex-cli") {
        // `rollout-<timestamp>-<thread id>.jsonl`: the thread id is the trailing UUID (measured: it is the hook's `session_id`).
        const match = /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(stem);
        return match === null ? null : match[1];
    }
    // Claude Code: `<session id>.jsonl`. Cursor: `<conversation id>/<conversation id>.jsonl`.
    return stem === "" ? null : stem;
}
/** A regular file's size and time. `lstat`, so a symlink is not a session; metadata only. */
function statFile(path) {
    try {
        const stat = lstatSync(path);
        return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : null;
    }
    catch {
        return null;
    }
}
/**
 * Plan the offer from a scan. ⛔ Opens no transcript: a session's size is its `lstat`, and "unsent" is a comparison with the
 * offset ledger the hooks already keep — a state file, not a transcript.
 */
export function planBackfill(ctx, scanFn = scanMachine) {
    const scanned = scanFn(ctx.home, ctx.env);
    // Asked of git here and not read from the scan: `connect`'s seam hands this the picker's repos and not the scan's whole answer.
    const reflogOf = new Map();
    const hasReflog = (clone) => {
        if (!reflogOf.has(clone))
            reflogOf.set(clone, firstReflogSeconds(clone) !== null);
        return reflogOf.get(clone) === true;
    };
    const keysOf = new Map();
    const keysFor = (clone) => {
        if (!keysOf.has(clone))
            keysOf.set(clone, resolveProjectKeys(clone));
        return keysOf.get(clone) ?? null;
    };
    const repos = [];
    const noReflog = new Map();
    let total = 0;
    let cursorSessions = 0;
    let overSize = 0;
    for (const repo of scanned.repos) {
        const candidates = [];
        const admitted = new Map();
        for (const member of repo.members ?? []) {
            const keys = keysFor(member.clone);
            if (keys === null)
                continue;
            if (!admitted.has(member.clone)) {
                admitted.set(member.clone, isCaptureAllowed(ctx.home, keys, () => repo.slug));
            }
            if (admitted.get(member.clone) !== true)
                continue;
            const found = statFile(member.session.path);
            if (found === null)
                continue;
            const sessionId = sessionIdOf(member.agent, member.session.path);
            const sent = sessionId === null
                ? 0
                : fileState(loadSessionState(ctx.home, { repoKey: member.clone, sessionId }), "main").sentOffset;
            if (sent >= found.size)
                continue;
            if (member.agent === "cursor") {
                cursorSessions += 1;
                continue;
            }
            // A clone with no reflog skips backfill entirely: its transcripts cannot be told from a previous repo's at the same path.
            if (!hasReflog(member.clone)) {
                noReflog.set(member.clone, (noReflog.get(member.clone) ?? 0) + 1);
                continue;
            }
            if (found.size > MAX_SESSION_BYTES) {
                overSize += 1;
                continue;
            }
            candidates.push(candidateOf(member, repo.slug, sessionId, found));
        }
        if (candidates.length === 0)
            continue;
        // Oldest first: the order a re-run resumes in.
        candidates.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
        repos.push({ slug: repo.slug, candidates });
        total += candidates.length;
    }
    const parent = planParentSessions(ctx, scanned);
    total += parent.length;
    return {
        repos,
        parent,
        total,
        cursorSessions,
        overSize,
        noReflog: [...noReflog.entries()].map(([path, sessions]) => ({ path, sessions })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
}
/**
 * The sessions run from folders outside every repository, minus those already fully delivered. ⛔ Opens no transcript. Offered only
 * where this machine consents to anything at all. Only a dialect that can isolate records (Claude Code and Codex; see `isolatesContentRecords`):
 * Cursor records no folder, so it is not offered. A session whose target
 * record says it is settled with every target's ledger at its end is done; one that touched nothing chosen is re-checked each run
 * (cheap, and a later grant may change the answer), which the offer says plainly.
 */
function planParentSessions(ctx, scanned) {
    const nowMs = (ctx.now ?? (() => new Date()))().getTime();
    if (!hasAnyConsent(ctx.home))
        return [];
    const out = [];
    for (const folder of scanned.folders ?? []) {
        for (const member of folder.members ?? []) {
            // ⛔ C28: only a dialect that can isolate records (`isolatesContentRecords`) is offered here: a parent-folder session is judged by the
            // repos its records name, and a dialect that cannot keep one repo's copy free of another's would send every repo it named the
            // others' prompts and output. Such a session is uploaded, if at all, by the in-repo path, to the repo it ended in.
            if (!agentIsolatesRecords(member.agent))
                continue;
            const found = statFile(member.session.path);
            if (found === null || found.size > MAX_SESSION_BYTES)
                continue;
            const sessionId = sessionIdOf(member.agent, member.session.path);
            if (sessionId === null)
                continue;
            if (parentDone(ctx.home, ctx.env, sessionId, member.session.path, found.size, nowMs - found.mtimeMs >= SESSION_LIVE_WINDOW_MS))
                continue;
            out.push({
                agent: member.agent,
                sessionId,
                path: member.session.path,
                dir: folder.path,
                mtimeMs: found.mtimeMs,
                startedMs: member.session.startedMs ?? member.session.mtimeMs,
                size: found.size,
            });
        }
    }
    return out.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.path < b.path ? -1 : 1));
}
/**
 * Has this target's ledger sent EVERY stream of the session to its end (C29 ii)? The main stream to `mainEof` and each delegated file to
 * its own size, each capped at `sizeCap[fileKey]` when the target is a folder's (a folder never sends past what was scanned).
 */
function streamsSentTo(state, mainEof, subs, sizeCap) {
    if (fileState(state, "main").sentOffset < mainEof)
        return false;
    for (const sub of subs) {
        const to = sizeCap === undefined ? sub.size : Math.min(sub.size, sizeCap[sub.fileKey] ?? 0);
        if (fileState(state, sub.fileKey).sentOffset < to)
            return false;
    }
    return true;
}
/**
 * Nothing a backfill could add for this session, under TODAY's consent and the file's CURRENT size (C18 #9, #10). Needs no transcript
 * read: it is decided from the session's target record and its ledgers.
 *
 *   - discovery is settled (the whole transcript was read and no root is waiting);
 *   - every repo root the record names that is GRANTED NOW has a target whose ledger has sent to the current end of the file and
 *     holds nothing back. A repo granted after the session was last uploaded has no target yet, so the session is offered again,
 *     and the run then uploads only the repos that still owe bytes;
 *   - the folder decision still holds: a folder target is done only when the scan reached the current end AND its ledger sent that
 *     far (bytes appended since are offered, not skipped for ever), and a session that named no repository at all whose launch
 *     folder is granted now but has no folder target yet is not done.
 */
function parentDone(home, env, sessionId, transcriptPath, size, quiet) {
    const record = loadTargetRecord(home, sessionId);
    if (record === null || !record.settled)
        return false;
    // ⛔ C29 (i): THE SCAN MUST HAVE SEEN EVERY STREAM AS IT IS NOW. `settled` says the streams that were scanned were read to their end;
    // it says nothing about a delegated file that appeared, or a file that GREW, since. Each stream's cursor remembers the size it
    // scanned (`size`), so a stream whose file is a different size now has unread bytes, and a stream with no cursor at all was never read.
    // A directory that cannot be LISTED is not an empty one (C17 #2): the delegated streams are unknown, so the session is not done.
    const listing = findSubagentTranscriptsChecked(home, env, transcriptPath);
    if (listing.listFailed)
        return false;
    const subs = listing.found;
    let scanCurrent = record.scan.main?.size === size;
    for (const sub of subs)
        if (record.scan[sub.fileKey]?.size !== sub.size)
            scanCurrent = false;
    // The one exception is C21 #3: a FOLDER target the server refused for good can never be sent, so bytes appended after the refusal do
    // not bring the session back (they could only ever be sent under that same folder).
    const folderRefused = record.targets.some((t) => t.kind === "folder" && record.stopped[stopKeyOf(t)] !== undefined);
    if (!scanCurrent && !folderRefused)
        return false;
    // ⛔ C29 (ii), the same rule for what was SENT: every stream of the target (main and each delegated file), not main alone.
    const sentToEnd = (target) => {
        const state = loadSessionState(home, { repoKey: target.ledgerKey, sessionId });
        // ⛔ C35 (v): A QUIET SESSION IS NOT DONE UNTIL IT IS SEALED. An upload made while the transcript was recent or running leaves the target
        // unfinalized; once the file has been quiet for the live window `uploadParent` would seal it, so the session must be offered again
        // for that. (A session still running is not asked to seal: `quiet` is false.)
        return state.endHold === null && streamsSentTo(state, size, subs, undefined) && (state.finalized !== null || !quiet);
    };
    const owed = new Set();
    for (const info of Object.values(record.roots)) {
        if (info.state !== "repo")
            continue;
        if (captureStanding(home, { worktree: info.toplevel, consent: info.commonDir }, info.slug) !== "granted")
            continue;
        owed.add(groupKey(info));
    }
    for (const key of owed) {
        const target = record.targets.find((t) => t.kind === "repo" && t.groupKey === key);
        // A target the server refused for good (C3: `record.stopped`) owes nothing: it can never be sent, and `status` names it. Without
        // this the session would be offered again on every run and then reported with the wrong reason.
        if (target !== undefined && record.stopped[stopKeyOf(target)] !== undefined)
            continue;
        if (target === undefined || !sentToEnd(target))
            return false;
    }
    const noRepoNamed = Object.keys(record.roots).length === 0 && record.unresolved.length === 0 && !record.oversize;
    const folder = record.targets.find((t) => t.kind === "folder");
    if (folder !== undefined) {
        if (record.stopped[stopKeyOf(folder)] !== undefined)
            return true;
        if (noRepoNamed && folderStandingOf(home, folder.folder ?? "") === "granted") {
            return record.scan.main?.offset === size && sentToEnd(folder);
        }
        return true;
    }
    if (noRepoNamed && record.launchFolder !== null) {
        try {
            if (folderStandingOf(home, realpathSync(record.launchFolder)) === "granted")
                return false;
        }
        catch {
            // A launch folder that is gone cannot be a folder target.
        }
    }
    return true;
}
function candidateOf(member, slug, sessionId, found) {
    return {
        agent: member.agent,
        slug,
        sessionId,
        path: member.session.path,
        dir: member.dir,
        clone: member.clone,
        commonDir: member.commonDir,
        mtimeMs: found.mtimeMs,
        startedMs: member.session.startedMs ?? member.session.mtimeMs,
        size: found.size,
    };
}
// ---------------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------------
const AGENT_ORDER = DIALECTS.map((dialect) => dialect.id);
function folderRows(repo) {
    const byDir = new Map();
    for (const candidate of repo.candidates) {
        const counts = byDir.get(candidate.dir) ?? { "claude-code": 0, "codex-cli": 0, cursor: 0 };
        counts[candidate.agent] += 1;
        byDir.set(candidate.dir, counts);
    }
    const sum = (counts) => AGENT_ORDER.reduce((n, id) => n + counts[id], 0);
    return [...byDir.entries()]
        .map(([dir, counts]) => ({ dir, counts }))
        // The folder with the most sessions first, then by path, so the order is the same on every run.
        .sort((a, b) => sum(b.counts) - sum(a.counts) || (a.dir < b.dir ? -1 : 1));
}
/** The muted lines under the repo list: what is NOT offered, and why. Each is a claims row. */
function notOfferedLines(plan, colour, home) {
    const lines = [];
    if (plan.cursorSessions > 0)
        lines.push(...wrap(BACKFILL.cursorNotUploaded(plan.cursorSessions), ROW_INDENT));
    if (plan.overSize > 0)
        lines.push(...wrap(BACKFILL.overSizeNote(plan.overSize), ROW_INDENT));
    for (const clone of plan.noReflog) {
        // Left-cut to leave room for the sentence around it (§13.4); the clone's last segments identify it.
        lines.push(...wrap(BACKFILL.noReflogNote(clone.sessions, truncatePath(tildePath(clone.path, home), 40)), ROW_INDENT));
    }
    return lines.map((line) => paint(colour, "muted", line));
}
/**
 * The offer, as lines (§10.14, as VQ redrew it after the PR 5 review). SGR roles: `text` the repo rows and the question,
 * `muted` the folder rows and the not-offered lines. `nowMs` is an argument so a golden file pins the clock.
 *
 * ## Widths
 *
 * ⛔ A folder path is cut from the LEFT to fit 80 columns whatever the slug width (§13.4, D27): the folder column is never
 * narrowed to the slug column. The right-hand text (counts, agents) starts at one shared column: the slug column, or further
 * right if a path needs it, and never so far that a line passes 80.
 */
export function renderOffer(plan, options) {
    const { colour, home, nowMs } = options;
    const countsOf = (repo) => `${BACKFILL.notYetUploaded(repo.candidates.length)} · ${SCAN.since(shortDate(Math.min(...repo.candidates.map((candidate) => candidate.startedMs)), nowMs))}`;
    const agentsOf = (counts) => AGENT_ORDER.filter((id) => counts[id] > 0)
        .map((id) => `${SCAN.agent[id]} ${counts[id]}`)
        .join(" · ");
    const folders = plan.repos.map((repo) => folderRows(repo));
    const widestRight = Math.max(0, ...plan.repos.map(countsOf).map((text) => text.length), ...folders.flatMap((rows) => rows.map((row) => agentsOf(row.counts).length)));
    // The column the right-hand text may start at without passing 80.
    const limit = WRAP_COLUMNS - widestRight;
    const slugWidth = Math.max(8, Math.min(SLUG_MAX, ...[Math.max(0, ...plan.repos.map((repo) => repo.slug.length))], limit - ROW_INDENT - COLUMN_GAP));
    const pathCap = Math.max(PATH_MIN, limit - FOLDER_INDENT - 2);
    const pathOf = (dir) => truncatePath(tildePath(dir, home), pathCap);
    const longestPath = Math.max(0, ...folders.flatMap((rows) => rows.map((row) => pathOf(row.dir).length)));
    const column = Math.max(ROW_INDENT + slugWidth + COLUMN_GAP, FOLDER_INDENT + longestPath + 2);
    const lines = [""];
    if (plan.repos.length > 0)
        lines.push(...wrap(BACKFILL.offerHeading(plan.repos.length, options.standalone !== false), 2), "");
    for (const [index, repo] of plan.repos.entries()) {
        lines.push(`${" ".repeat(ROW_INDENT)}${paint(colour, "text", `${truncateMiddle(repo.slug, slugWidth).padEnd(column - ROW_INDENT)}${countsOf(repo)}`)}`);
        for (const row of folders[index]) {
            lines.push(`${" ".repeat(FOLDER_INDENT)}${paint(colour, "muted", `${pathOf(row.dir).padEnd(column - FOLDER_INDENT)}${agentsOf(row.counts)}`)}`);
        }
    }
    const parent = plan.parent ?? [];
    if (parent.length > 0) {
        // R4: sessions run from folders outside a repository. Their repositories are not known until the transcript is read, after the
        // yes, so this block says what will be CHECKED and what the check can find: never a promise of an upload.
        if (plan.repos.length > 0)
            lines.push("");
        lines.push(...wrap(BACKFILL.parentHeading(parent.length), 2), "");
        const byDir = new Map();
        for (const candidate of parent)
            byDir.set(candidate.dir, (byDir.get(candidate.dir) ?? 0) + 1);
        const rows = [...byDir.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        const parentCap = Math.max(PATH_MIN, WRAP_COLUMNS - ROW_INDENT - COLUMN_GAP - BACKFILL.parentRowCounts(99999).length);
        const shown = rows.map(([dir, count]) => ({ path: truncatePath(tildePath(dir, home), parentCap), count }));
        const width = Math.max(...shown.map((row) => row.path.length));
        for (const row of shown) {
            lines.push(`${" ".repeat(ROW_INDENT)}${paint(colour, "text", `${row.path.padEnd(width + COLUMN_GAP)}${BACKFILL.parentRowCounts(row.count)}`)}`);
        }
        lines.push("", ...wrap(BACKFILL.parentNote, ROW_INDENT).map((line) => paint(colour, "muted", line)));
    }
    const notOffered = notOfferedLines(plan, colour, home);
    if (notOffered.length > 0)
        lines.push("", ...notOffered);
    lines.push("", ...BACKFILL.uploadNote.map((line) => `  ${line}`), "");
    return lines;
}
// ---------------------------------------------------------------------------
// The folder check — exception 1. It no longer reads a transcript itself.
// ---------------------------------------------------------------------------
/**
 * The `cwd` of the transcript's first record that has one. ⛔ ONE VALUE, and ONE READER: this is a call to
 * `scanTranscriptKeys` (`session_targets.ts`, R13 · D15 · A), the only code that reads a field out of a transcript, with
 * the spec narrowed to a top-level `cwd` and nothing else, so the 10-24 one-value reading of D60 §D6 exception 1 is exactly
 * what backfill's own check still does. `none` (no record carries one in the first `FOLDER_CHECK_MAX_BYTES`) and
 * `unreadable` (the file cannot be opened) both fail closed — the session is skipped — but they are different facts and
 * are told apart.
 */
export function firstRecordedCwd(path) {
    const scan = scanTranscriptKeys(path, 0, FOLDER_CHECK_MAX_BYTES, TOP_LEVEL_CWD_ONLY, {
        first: true,
        includeUnterminatedTail: true,
    });
    if (scan.kind === "unreadable")
        return { kind: "unreadable" };
    const found = scan.hits.find((hit) => hit.kind === "cwd");
    return found === undefined ? { kind: "none" } : { kind: "found", cwd: found.value };
}
/**
 * Does the folder the session recorded still resolve to the clone it was matched to?
 *
 * ⛔ The recorded value must be ABSOLUTE. A relative one (`.`) would resolve against whatever directory this process runs in,
 * and a crafted transcript could then name the clone it is run from.
 */
function folderMatches(recorded, commonDir) {
    if (!isAbsolute(recorded))
        return false;
    try {
        const keys = resolveProjectKeys(realpathSync(recorded));
        return keys !== null && keys.consent === commonDir;
    }
    catch {
        // Deleted, or not reachable: a folder that is not this clone.
        return false;
    }
}
// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------
/** The sessions running right now, by the agents' own environment variables — never sealed (§6). */
function runningSessionIds(env) {
    const ids = new Set();
    for (const dialect of DIALECTS) {
        const id = dialect.sessionIdFromEnv(env);
        if (id !== null)
            ids.add(id);
    }
    return ids;
}
/** The disposition classes of §10.14, from what the close returned. */
function classify(outcome) {
    switch (outcome.kind) {
        case "stopped":
            return { kind: "rejected" };
        case "delivered":
        case "sealed":
        case "already":
        case "refused":
        case "unacknowledged":
            return { kind: "uploaded" };
        case "never-captured":
            return { kind: "failed", reason: BACKFILL.refusedByServer };
        case "lock-lost":
            // C25: another writer took the session while this run held it; nothing more was written. The session is "busy", as when the
            // lock could not be had at all, and a later run uploads what is left.
            return { kind: "skipped", reason: BACKFILL.parentBusy };
        case "not-delivered":
        case "subagents-held": {
            const delivery = outcome.delivery;
            if (delivery.kind === "stopped")
                return { kind: "rejected" };
            if (delivery.kind === "nothing-to-send")
                return { kind: "uploaded" };
            if (delivery.kind === "no-repo")
                return { kind: "failed", reason: BACKFILL.noRepoIdentity };
            if (delivery.disposition === "ok")
                return { kind: "uploaded" };
            if (delivery.disposition === "fatal")
                return { kind: "rejected" };
            if (delivery.disposition === "later") {
                // A 403 is `later` by status (`policy.ts`), so the two refusals that share it are told apart by their CODE:
                // an org that has not approved capture HOLDS the repo; a repo another org owns FAILS the session with its reason
                // (`resolve_repository`'s ownership oracle) — neither is "the server is busy", which is what stops a run.
                if (delivery.detail?.code === CAPTURE_NOT_APPROVED)
                    return { kind: "held" };
                if (delivery.detail?.code === "repository_forbidden") {
                    return { kind: "failed", reason: BACKFILL.repositoryForbidden };
                }
                return { kind: "stopped", unreachable: delivery.unreachable === true };
            }
            return { kind: "failed", reason: BACKFILL.refusedByServer };
        }
    }
}
/**
 * U5b — what a session's recorded firings are replayed with (`finalize.takeSessionLock`), under the lock `resolveSessionTargets` takes, BEFORE
 * the close reads the spool union: after U6 the hook promotes nothing and writes no state file, so a replay is the only thing that does.
 */
function replayConfigOf(run) {
    const { ctx } = run;
    return { home: ctx.home, env: ctx.env, nodeVersion: ctx.nodeVersion, identity: identityDigest({ url: run.url, env: ctx.env }), url: run.url };
}
/** A replay that left a firing unconsumed: no close, so no seal over lines it still owes. A rejected credential is the run's `rejected`. */
function replayStopped(step) {
    return step.kind === "fatal" && step.why === "rejected" ? { kind: "rejected" } : { kind: "failed", reason: BACKFILL.replayStopped };
}
async function uploadOne(run, candidate) {
    const { ctx } = run;
    const found = statFile(candidate.path);
    if (found === null)
        return { kind: "skipped", reason: BACKFILL.fileGone };
    // The plan leaves these out; the file may have grown since, so the run still holds the line.
    if (found.size > MAX_SESSION_BYTES)
        return { kind: "skipped", reason: BACKFILL.overSize };
    if (!admitsTranscript(ctx.home, ctx.env, candidate.path)) {
        return { kind: "skipped", reason: BACKFILL.outsideAgentFolder };
    }
    if (candidate.sessionId === null)
        return { kind: "failed", reason: BACKFILL.unrecognisedFileName };
    const keys = resolveProjectKeys(candidate.clone);
    if (keys === null)
        return { kind: "failed", reason: BACKFILL.noRepoIdentity };
    // ⛔ THE CONSENT GATE AGAIN, BEFORE ANYTHING IS READ. The offer was planned a while ago; `vibecommit off` (or a removed grant)
    // since then must stop the rest of this repo, not just the ones not yet offered.
    if (!isCaptureAllowed(ctx.home, keys, () => candidate.slug))
        return { kind: "skipped", reason: BACKFILL.turnedOff };
    // Exception 1. A Claude Code session says where it started inside its own transcript; Codex's index already did.
    if (candidate.agent === "claude-code") {
        const recorded = run.readCwd(candidate.path);
        if (recorded.kind === "unreadable")
            return { kind: "skipped", reason: BACKFILL.couldntBeRead };
        if (recorded.kind === "none")
            return { kind: "skipped", reason: BACKFILL.folderNotRecorded };
        if (!folderMatches(recorded.cwd, candidate.commonDir))
            return { kind: "skipped", reason: BACKFILL.folderDiffers };
    }
    const quiet = ctx.now().getTime() - found.mtimeMs >= SESSION_LIVE_WINDOW_MS;
    // ⛔ EVERY BACKFILL UPLOAD GOES THROUGH THE ONE RESOLVER, UNDER THE SESSION'S ONE WRITER LOCK (C18 #3). This path used to call
    // `closeSession` with `keys.worktree` directly: no lock (it could interleave with a live hook on the same session) and no sticky
    // ledger (a session the hook already adopted another work tree's ledger for would start a second ledger and re-send from 0). The
    // resolver gives the target this repo already has for the session, ledger and slug included.
    //
    // ⛔ NO FALLBACK UPLOAD (C21 #1). When the resolver returns no target for this repo, the session is SKIPPED: nothing is sent and no
    // ledger is written. It returns none when the strict slug failed (git timed out: the old fallback answered `local:<hash>`, a WRONG
    // repository identity that a later hook would then adopt along with its ledger) or when the root was deferred (a fresh ledger at
    // `keys.worktree` is the double send that deferral exists to prevent). The next run, with git answering, uploads it properly.
    const releases = [];
    try {
        // `turnEndCwd` is the folder the OFFER verified this session belongs to (the agent's own index, or the first `cwd` the transcript
        // records): the evidence that put it in this repo's offer, handed to the resolver so a transcript with no `cwd` of its own still
        // resolves. It cannot name a repo the offer did not (the candidate is this repo's) and it is no fallback identity.
        const resolved = await resolveSessionTargets({ home: ctx.home, env: ctx.env, nowMs: ctx.now().getTime(), turnEndCwd: candidate.dir }, candidate.sessionId, candidate.path, { keys, slugOf: onceStrictRepoSlug(keys.worktree) }, releases, { replay: replayConfigOf(run) });
        if (resolved.kind === "busy")
            return { kind: "skipped", reason: BACKFILL.parentBusy };
        if (resolved.kind === "replay-stopped")
            return replayStopped(resolved.step);
        const heartbeat = resolved.heartbeat;
        // This repo's target: one of its work trees, or any work tree of the same git common dir (a session recorded in a LINKED work tree
        // belongs to the clone the offer was made for).
        const own = resolved.targets.find((target) => target.kind === "repo" &&
            (target.worktrees.includes(keys.worktree) || target.ledgerKey === keys.worktree || target.commonDir === keys.consent));
        if (own === undefined)
            return { kind: "failed", reason: BACKFILL.noRepoIdentity };
        const spec = closeSpecOf(own, resolved.scan, resolved);
        const outcome = await run.close({
            home: ctx.home,
            env: ctx.env,
            nodeVersion: ctx.nodeVersion,
            agentId: candidate.agent,
            cwd: candidate.dir,
            url: run.url,
            credential: run.credential,
            projectKey: spec.projectKey,
            redactionRoots: spec.redactionRoots,
            repoSlug: spec.repoSlug,
            sessionId: candidate.sessionId,
            transcriptPath: candidate.path,
            eof: found.size,
            // Sealed only when the transcript has been quiet for 30 minutes and it is not the session running this command.
            seal: quiet && !run.running.has(candidate.sessionId),
            allowNeverCaptured: true,
            completeSubagents: true,
            worktrees: spec.worktrees,
            ...(spec.isolation === undefined ? {} : { isolation: spec.isolation }),
            heartbeat,
        });
        return classify(outcome);
    }
    finally {
        for (const release of releases) {
            try {
                release();
            }
            catch {
                // A lock that cannot be released ages out by itself.
            }
        }
    }
}
/**
 * One parent-folder session (R4): find, by the resolver `finalize` and the hook use, every granted repository it touched (and the
 * folder, when it touched none and the folder is granted), then close it once per target through `closeSession`, so a
 * multi-repo session uploads once per granted repo with each repo's own redaction scope. ⛔ The first read of this transcript
 * happens HERE, after the yes and after the consent check, one session at a time.
 */
async function uploadParent(run, candidate) {
    const { ctx } = run;
    const found = statFile(candidate.path);
    if (found === null)
        return { kind: "skipped", reason: BACKFILL.fileGone };
    if (found.size > MAX_SESSION_BYTES)
        return { kind: "skipped", reason: BACKFILL.overSize };
    if (!admitsTranscript(ctx.home, ctx.env, candidate.path))
        return { kind: "skipped", reason: BACKFILL.outsideAgentFolder };
    // ⛔ NOTHING IS READ without some consent on the machine (`vibecommit off` everywhere since the offer leaves nothing to find).
    if (!hasAnyConsent(ctx.home))
        return { kind: "skipped", reason: BACKFILL.turnedOff };
    const releases = [];
    try {
        const resolved = await resolveSessionTargets({ home: ctx.home, env: ctx.env, nowMs: ctx.now().getTime(), turnEndCwd: null }, candidate.sessionId, candidate.path, null, releases, { replay: replayConfigOf(run) });
        if (resolved.kind === "busy")
            return { kind: "skipped", reason: BACKFILL.parentBusy };
        if (resolved.kind === "replay-stopped")
            return replayStopped(resolved.step);
        const heartbeat = resolved.heartbeat;
        if (resolved.targets.length === 0)
            return { kind: "skipped", reason: BACKFILL.parentTouchedNothing };
        const quiet = ctx.now().getTime() - found.mtimeMs >= SESSION_LIVE_WINDOW_MS;
        const results = [];
        for (const target of resolved.targets) {
            const spec = closeSpecOf(target, resolved.scan, resolved);
            // ⛔ A target that is already delivered to the end of what this run would send, and already sealed when this run would seal
            // (or would not seal), owes nothing (C18 #9): a repo chosen LATER brings the session back into the offer, and only the repos
            // that still owe bytes are uploaded. Re-closing the others would send each an empty final request for nothing.
            const sealing = quiet && !run.running.has(candidate.sessionId);
            const toEof = spec.sizeCap === undefined ? found.size : Math.min(found.size, spec.sizeCap.main ?? 0);
            const ledger = loadSessionState(ctx.home, { repoKey: spec.projectKey, sessionId: candidate.sessionId });
            // ⛔ C29 (ii): ONLY WHEN EVERY STREAM IS AT ITS END. Main alone said "delivered" for a session whose delegated files (new since, or
            // never sent) still owed bytes, and the target was skipped with them unsent.
            // A listing that FAILED (EACCES, EIO) is "unknown", never "no delegated streams": the target is not skipped, and `run.close` handles it.
            const subListing = findSubagentTranscriptsChecked(ctx.home, ctx.env, candidate.path);
            if (!subListing.listFailed &&
                ledger.endHold === null &&
                streamsSentTo(ledger, toEof, subListing.found, spec.sizeCap) &&
                (ledger.finalized !== null || !sealing)) {
                results.push({ kind: "uploaded" });
                continue;
            }
            const outcome = await run.close({
                home: ctx.home,
                env: ctx.env,
                nodeVersion: ctx.nodeVersion,
                agentId: candidate.agent,
                cwd: candidate.dir,
                url: run.url,
                credential: run.credential,
                projectKey: spec.projectKey,
                redactionRoots: spec.redactionRoots,
                repoSlug: spec.repoSlug,
                sessionId: candidate.sessionId,
                transcriptPath: candidate.path,
                eof: spec.sizeCap === undefined ? found.size : Math.min(found.size, spec.sizeCap.main ?? 0),
                seal: quiet && !run.running.has(candidate.sessionId),
                allowNeverCaptured: true,
                completeSubagents: true,
                worktrees: spec.worktrees,
                ...(spec.sizeCap === undefined ? {} : { sizeCap: spec.sizeCap }),
                ...(spec.isolation === undefined ? {} : { isolation: spec.isolation }),
                heartbeat,
            });
            // C25: the lock was taken from us. Stop BEFORE the next target's write.
            if (outcome.kind === "lock-lost") {
                results.push(classify(outcome));
                break;
            }
            // C3: the server refused THIS folder target for good. Stopped and recorded; it does not fail the session or the run.
            if ("delivery" in outcome &&
                outcome.delivery.kind === "attempted" &&
                outcome.delivery.detail?.code === FOLDER_REPOSITORY_FORBIDDEN) {
                // C35 (iii): the stop is a write, so only while the session is still ours (the 403 is reported either way).
                if (heartbeat())
                    stopTarget(ctx.home, candidate.sessionId, target, FOLDER_REPOSITORY_FORBIDDEN, Date.now());
                results.push({ kind: "skipped", reason: BACKFILL.parentFolderRefused });
                continue;
            }
            const result = classify(outcome);
            results.push(result.kind === "held" ? { kind: "held", slug: target.slug } : result);
        }
        // One answer for the session: a stop of the run wins, then a hold, then a failure; else it uploaded if anything did.
        return (results.find((r) => r.kind === "rejected") ??
            results.find((r) => r.kind === "stopped") ??
            results.find((r) => r.kind === "held") ??
            results.find((r) => r.kind === "failed") ??
            // C25: a lock lost part-way leaves a target unsent, so the session is not "uploaded" however many targets went first. It is
            // busy: a later run finds what is still owed (`parentDone` reads the ledgers) and sends it.
            results.find((r) => r.kind === "skipped" && r.reason === BACKFILL.parentBusy) ??
            results.find((r) => r.kind === "uploaded") ??
            results[0]);
    }
    finally {
        for (const release of releases) {
            try {
                release();
            }
            catch {
                // A lock that cannot be released ages out by itself.
            }
        }
    }
}
const newTally = () => ({
    uploaded: 0,
    held: 0,
    stopped: false,
    unreachable: false,
    rejected: false,
    skipped: new Map(),
    failed: new Map(),
});
const bump = (into, key) => void into.set(key, (into.get(key) ?? 0) + 1);
function tallyLine(tally) {
    const parts = [];
    if (tally.uploaded > 0)
        parts.push(BACKFILL.uploaded(tally.uploaded));
    for (const [reason, count] of tally.skipped)
        parts.push(BACKFILL.skipped(count, reason));
    if (tally.held > 0)
        parts.push(BACKFILL.held(tally.held));
    for (const [reason, count] of tally.failed)
        parts.push(BACKFILL.failed(count, reason));
    if (tally.stopped)
        parts.push(BACKFILL.stopped);
    return parts.join(" · ");
}
const sumOf = (map) => [...map.values()].reduce((n, v) => n + v, 0);
/** "an acme-corp owner", "an owner of acme-corp or other-org". */
function ownersPhrase(slugs) {
    const owners = [...new Set(slugs.map((slug) => slug.split("/")[0]))].sort();
    if (owners.length === 1)
        return `${/^[aeiou]/i.test(owners[0]) ? "an" : "a"} ${owners[0]} owner`;
    const head = owners.slice(0, -1).join(", ");
    return `an owner of ${head} or ${owners[owners.length - 1]}`;
}
/** Ctrl+C for the run: the injected signal, or a real SIGINT listener that is removed on the way out. */
function interruption(deps) {
    if (deps.signal !== undefined)
        return { signal: deps.signal, dispose: () => undefined };
    const controller = new AbortController();
    const onSigint = () => {
        // A second Ctrl+C is "now": the first one waits for the session in flight.
        if (controller.signal.aborted)
            process.exit(EXIT.ok);
        controller.abort();
    };
    process.on("SIGINT", onSigint);
    return { signal: controller.signal, dispose: () => void process.off("SIGINT", onSigint) };
}
/**
 * Ask, then upload. Everything `backfill` and `connect` share. `connect` calls it AFTER its own grant y/N and its
 * "Capture is on" block (through `backfillForConnect`), and chooses its closing URL from `end`.
 */
export async function runBackfill(ctx, deps = {}) {
    const stop = (exit, end, uploaded = 0) => ({ exit, end, uploaded });
    // Not connected is a fact about the machine, so it is answered first; then the terminal (nothing to ask on).
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind === "absent") {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "NO_CREDENTIAL",
            what: BACKFILL.notConnectedWhat,
            why: [BACKFILL.notConnectedWhy],
            fixLabel: BACKFILL.notConnectedFixLabel,
            fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return stop(EXIT.notConnected, "refused");
    }
    if (load.kind !== "ok") {
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour, authCommandFor(ctx.env, ctx.selfPath)));
        return stop(EXIT.notConnected, "refused");
    }
    if (!ctx.stdinIsTty) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "BACKFILL_NEEDS_TTY",
            what: BACKFILL.nonInteractiveWhat,
            why: [BACKFILL.nonInteractiveWhy],
            fixLabel: BACKFILL.nonInteractiveFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)],
        }, ctx.colour));
        return stop(EXIT.usage, "refused");
    }
    const url = ingestUrl(ctx.env);
    if (url === null) {
        writeLines(ctx.stderr, ingestUrlUnavailableBlock(ctx));
        return stop(EXIT.failure, "refused");
    }
    // An unreadable `grants.json` denies every repo that has a remote, so "nothing to upload" would be a false answer.
    if (grantsUnreadable(ctx.home)) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "GRANTS_UNREADABLE",
            what: BACKFILL.grantsUnreadableWhat,
            why: [BACKFILL.grantsUnreadableWhy],
            fixLabel: BACKFILL.grantsUnreadableFixLabel,
            fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)],
        }, ctx.colour));
        return stop(EXIT.failure, "refused");
    }
    const plan = planBackfill(ctx, deps.scanMachine ?? scanMachine);
    if (plan.total === 0) {
        const notes = notOfferedLines(plan, ctx.colour, ctx.home);
        writeLines(ctx.stdout, ["", ...wrap(BACKFILL.nothingToUpload, 2), ...(notes.length > 0 ? ["", ...notes] : [])]);
        return stop(EXIT.empty, "nothing");
    }
    writeLines(ctx.stdout, renderOffer(plan, {
        colour: ctx.colour,
        home: ctx.home,
        nowMs: ctx.now().getTime(),
        standalone: deps.fromConnect !== true,
    }));
    const { signal, dispose } = interruption(deps);
    try {
        let answer;
        try {
            answer = await ctx.ask(`  ${paint(ctx.colour, "text", BACKFILL.question(plan.total))}`);
        }
        catch {
            // Ctrl+C at the question rejects the prompt. Capture is on, so this is a stop and not a failure.
            writeLines(ctx.stdout, ["", ...wrap(BACKFILL.interrupted(channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)), 2)]);
            return stop(EXIT.ok, "interrupted");
        }
        if (!/^\s*y(es)?\s*$/i.test(answer)) {
            writeLines(ctx.stdout, ["", ...wrap(BACKFILL.declined(channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)), 2)]);
            return stop(EXIT.ok, "declined");
        }
        return await upload(ctx, plan, { url, credential: load.credential }, deps, signal);
    }
    finally {
        dispose();
    }
}
async function upload(ctx, plan, connection, deps, signal) {
    const run = {
        ctx,
        url: connection.url,
        credential: connection.credential,
        close: deps.closeSession ?? closeSession,
        readCwd: deps.readCwd ?? firstRecordedCwd,
        running: runningSessionIds(ctx.env),
    };
    const parent = plan.parent ?? [];
    const names = [...plan.repos.map((repo) => repo.slug), ...(parent.length > 0 ? [BACKFILL.parentLabel] : [])];
    const column = ROW_INDENT + Math.min(SLUG_MAX, Math.max(...names.map((name) => name.length))) + COLUMN_GAP;
    const nameLine = (name, text) => `${" ".repeat(ROW_INDENT)}${truncateMiddle(name, column - ROW_INDENT - COLUMN_GAP).padEnd(column - ROW_INDENT)}${text}`;
    /** A repo's sessions, then the parent-folder group. A repo whose owner has not approved capture is held whole; the parent group is not (its targets differ per session). */
    const groups = [
        ...plan.repos.map((repo) => ({ name: repo.slug, slug: repo.slug, items: repo.candidates })),
        ...(parent.length > 0 ? [{ name: BACKFILL.parentLabel, slug: null, items: parent }] : []),
    ];
    writeLines(ctx.stdout, [...wrap(BACKFILL.runHeading(plan.total), 2)]);
    let uploaded = 0;
    let skipped = 0;
    let held = 0;
    let failed = 0;
    const heldRepos = [];
    for (const group of groups) {
        const tally = newTally();
        let slowShown = false;
        const timer = setTimeout(() => {
            // A static line, overwritten once when the repo finishes — and only where an overwrite is possible (§13.8).
            slowShown = true;
            ctx.stdout.write(`${paint(ctx.colour, "muted", nameLine(group.name, "…"))}`);
        }, deps.slowAfterMs ?? SLOW_REPO_MS);
        let heldRepo = false;
        try {
            for (const candidate of group.items) {
                if (signal.aborted)
                    break;
                // A repo whose owner has not approved capture is held whole: the rest of it is not even tried.
                const result = heldRepo && group.slug !== null
                    ? { kind: "held" }
                    : "clone" in candidate
                        ? await uploadOne(run, candidate)
                        : await uploadParent(run, candidate);
                if (result.kind === "uploaded")
                    tally.uploaded += 1;
                else if (result.kind === "skipped")
                    bump(tally.skipped, result.reason);
                else if (result.kind === "failed")
                    bump(tally.failed, result.reason);
                else if (result.kind === "held") {
                    tally.held += 1;
                    if (group.slug !== null)
                        heldRepo = true;
                    else if (result.slug !== undefined)
                        heldRepos.push(result.slug);
                }
                else {
                    // `stopped` (the server asked to try later, or could not be reached) and `rejected` (the credential was refused)
                    // end the whole run.
                    tally.stopped = true;
                    tally.rejected = result.kind === "rejected";
                    tally.unreachable = result.kind === "stopped" && result.unreachable;
                    break;
                }
            }
        }
        finally {
            clearTimeout(timer);
        }
        if (signal.aborted && !tally.stopped) {
            if (slowShown)
                ctx.stdout.write("\n");
            writeLines(ctx.stdout, ["", ...wrap(BACKFILL.interrupted(channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)), 2)]);
            return { exit: EXIT.ok, end: "interrupted", uploaded: uploaded + tally.uploaded };
        }
        uploaded += tally.uploaded;
        skipped += sumOf(tally.skipped);
        failed += sumOf(tally.failed);
        held += tally.held;
        if (tally.held > 0 && group.slug !== null)
            heldRepos.push(group.slug);
        const role = tally.held > 0 || tally.stopped ? "warn" : "text";
        const line = paint(ctx.colour, role, nameLine(group.name, tallyLine(tally)));
        // Overwrite the `…` line in place on a terminal; elsewhere it stays and the result prints beneath it.
        ctx.stdout.write(slowShown && ctx.colour ? `\r${line}\n` : `${slowShown ? "\n" : ""}${line}\n`);
        if (tally.stopped)
            return stopRun(ctx, plan, uploaded, tally);
    }
    const clean = held === 0 && failed === 0;
    const summary = BACKFILL.summary(uploaded, plan.total, skipped, held, failed);
    const kind = clean ? "ok" : "warn";
    writeLines(ctx.stdout, ["", `  ${paint(ctx.colour, kind, glyph(ctx.colour, kind))} ${summary}`]);
    if (held > 0) {
        writeLines(ctx.stdout, [
            ...wrap(BACKFILL.heldBlock(ownersPhrase(heldRepos)), 4).map((l) => paint(ctx.colour, "muted", l)),
            `      ${paint(ctx.colour, "accent", URLS.captureAccess)}`,
            `    ${BACKFILL.heldThenRun} ${paint(ctx.colour, "accent", channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill))}`,
        ]);
    }
    return { exit: EXIT.ok, end: "uploaded", uploaded };
}
/**
 * A server `later` ended the run, the server could not be reached, or the credential was refused: the resume fix goes last
 * (§13.6). ⛔ The block states only what landed: `uploaded` is sessions the server took.
 */
function stopRun(ctx, plan, uploaded, tally) {
    const notUploaded = plan.total - uploaded;
    const block = tally.rejected
        ? renderErrorBlock({
            kind: "bad",
            code: "CREDENTIAL_REJECTED",
            what: BACKFILL.credentialStoppedWhat,
            why: [BACKFILL.credentialStoppedWhy],
            fixLabel: BACKFILL.credentialStoppedFixLabel,
            fixes: [authCommandFor(ctx.env, ctx.selfPath), channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)],
        }, ctx.colour)
        : renderErrorBlock({
            kind: "warn",
            what: BACKFILL.stopWhat(uploaded, plan.total),
            why: [tally.unreachable ? BACKFILL.stopWhyUnreachable(notUploaded) : BACKFILL.stopWhy(notUploaded)],
            fixLabel: BACKFILL.stopFixLabel,
            fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)],
        }, ctx.colour);
    writeLines(ctx.stdout, ["", ...block]);
    return { exit: EXIT.failure, end: "stopped", uploaded };
}
const NOTHING_NOT_LISTED = {
    noRemote: [],
    ambiguousSessions: 0,
    missingFolderSessions: 0,
    nonRepoSessions: 0,
    pathReusedSessions: 0,
    noReflogClones: [],
    unindexedSessions: 0,
    unreadableAgents: [],
};
/**
 * `connect`'s backfill step. It is handed the repos `connect`'s own scan found (the picker's), asks the backfill y/N
 * and runs, so the picker's scan is not repeated. It owns its Ctrl+C: stopping a backfill is `ran`, and the run has
 * already printed the stop line. A no, nothing waiting, and a refusal are all `declined`: `connect` ends on `/app`.
 *
 * ⚠ The consent gate runs HERE, over what `connect` just granted, not over what the scan saw before the grant: a repo the
 * user did not choose is dropped by `planBackfill` however it got into `repos`; so is a clone with no reflog, which the plan asks
 * git about itself.
 */
export async function backfillForConnect(ctx, repos, 
/** The folders outside every repository `connect`'s own scan found: their sessions are the parent-folder offer (R4). */
folders = [], deps = {}) {
    const result = await runBackfill(ctx, {
        ...deps,
        fromConnect: true,
        scanMachine: () => ({ repos, folders, notListed: NOTHING_NOT_LISTED }),
    });
    switch (result.end) {
        case "declined":
        case "nothing":
        case "refused":
            return { kind: "declined" };
        case "stopped":
            return { kind: "stopped", uploaded: result.uploaded };
        default:
            return { kind: "ran", uploaded: result.uploaded };
    }
}
// ---------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------
/**
 * `vibecommit backfill`. Exit `0` done (held sessions included: org-pending is 0, as in §10.2), `1` stopped with the resume
 * fix, `2` no terminal, `3` not connected, `4` nothing to upload. It ends on the dashboard URL after a completed run or a
 * no, and on its resume fix after a stop.
 */
export async function backfill(ctx, argv = [], deps = {}) {
    if (argv.includes("--help") || argv.includes("-h")) {
        const helpVerb = "backfill"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    if (argv.length > 0) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", code: "UNRECOGNIZED_ARGUMENT", what: BACKFILL.usageWhat, why: [BACKFILL.usageWhy] }, ctx.colour));
        return EXIT.usage;
    }
    const result = await runBackfill(ctx, deps);
    if (result.end === "uploaded" || result.end === "interrupted") {
        writeLines(ctx.stdout, ["", `  ${paint(ctx.colour, "accent", result.uploaded > 0 ? URLS.conversations : URLS.dashboard)}`]);
    }
    else if (result.end === "declined") {
        writeLines(ctx.stdout, ["", `  ${paint(ctx.colour, "accent", URLS.dashboard)}`]);
    }
    return result.exit;
}
//# sourceMappingURL=backfill.js.map