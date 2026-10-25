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
import { closeSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { admitsTranscript, DIALECTS } from "../agents/registry.js";
import { BACKFILL, COMMANDS, SCAN, URLS, shortDate } from "../copy/index.js";
import { grantsUnreadable, isCaptureAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { firstReflogSeconds, resolveRepoSlug } from "../git.js";
import { confinementRoots } from "../hooks/entry.js";
import { CAPTURE_NOT_APPROVED, ingestUrl } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { SESSION_LIVE_WINDOW_MS } from "../spool.js";
import { fileState, loadSessionState } from "../state.js";
import { glyph, paint, renderErrorBlock, tildePath, truncateMiddle, truncatePath, wrap, WRAP_COLUMNS } from "../term.js";
import { writeLines } from "./context.js";
import { credentialProblem } from "./credential_problem.js";
import { authCommandFor, channelCommand, connectCommandFor } from "../install.js";
import { closeSession, ingestUrlUnavailableBlock } from "./finalize.js";
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
    return {
        repos,
        total,
        cursorSessions,
        overSize,
        noReflog: [...noReflog.entries()].map(([path, sessions]) => ({ path, sessions })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    };
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
    const widestRight = Math.max(...plan.repos.map(countsOf).map((text) => text.length), ...folders.flatMap((rows) => rows.map((row) => agentsOf(row.counts).length)));
    // The column the right-hand text may start at without passing 80.
    const limit = WRAP_COLUMNS - widestRight;
    const slugWidth = Math.max(8, Math.min(SLUG_MAX, ...[Math.max(...plan.repos.map((repo) => repo.slug.length))], limit - ROW_INDENT - COLUMN_GAP));
    const pathCap = Math.max(PATH_MIN, limit - FOLDER_INDENT - 2);
    const pathOf = (dir) => truncatePath(tildePath(dir, home), pathCap);
    const longestPath = Math.max(...folders.flatMap((rows) => rows.map((row) => pathOf(row.dir).length)));
    const column = Math.max(ROW_INDENT + slugWidth + COLUMN_GAP, FOLDER_INDENT + longestPath + 2);
    const lines = ["", ...wrap(BACKFILL.offerHeading(plan.repos.length, options.standalone !== false), 2), ""];
    for (const [index, repo] of plan.repos.entries()) {
        lines.push(`${" ".repeat(ROW_INDENT)}${paint(colour, "text", `${truncateMiddle(repo.slug, slugWidth).padEnd(column - ROW_INDENT)}${countsOf(repo)}`)}`);
        for (const row of folders[index]) {
            lines.push(`${" ".repeat(FOLDER_INDENT)}${paint(colour, "muted", `${pathOf(row.dir).padEnd(column - FOLDER_INDENT)}${agentsOf(row.counts)}`)}`);
        }
    }
    const notOffered = notOfferedLines(plan, colour, home);
    if (notOffered.length > 0)
        lines.push("", ...notOffered);
    lines.push("", ...BACKFILL.uploadNote.map((line) => `  ${line}`), "");
    return lines;
}
// ---------------------------------------------------------------------------
// The folder check — exception 1. Everything between the markers is the ONLY code that reads a transcript.
// ---------------------------------------------------------------------------
// folder-check:begin
/**
 * The `cwd` of the transcript's first record that has one. ⛔ ONE VALUE. The record is parsed to read its top-level `cwd`
 * and nothing else is looked at, kept, returned or sent; a line that does not mention `"cwd"` is not parsed at all.
 * `none` (no record carries one in the first `FOLDER_CHECK_MAX_BYTES`) and `unreadable` (the file cannot be opened) both
 * fail closed — the session is skipped — but they are different facts and are told apart.
 */
export function firstRecordedCwd(path) {
    let fd;
    try {
        fd = openSync(path, "r");
    }
    catch {
        return { kind: "unreadable" };
    }
    try {
        const block = Buffer.alloc(64 * 1024);
        let pending = Buffer.alloc(0);
        let readBytes = 0;
        while (readBytes < FOLDER_CHECK_MAX_BYTES) {
            const n = readSync(fd, block, 0, block.length, readBytes);
            if (n === 0)
                break;
            readBytes += n;
            pending = Buffer.concat([pending, block.subarray(0, n)]);
            for (let end = pending.indexOf(0x0a); end >= 0; end = pending.indexOf(0x0a)) {
                const line = pending.subarray(0, end).toString("utf8");
                pending = pending.subarray(end + 1);
                if (!line.includes('"cwd"'))
                    continue;
                const cwd = cwdOfLine(line);
                if (cwd !== null)
                    return { kind: "found", cwd };
            }
        }
        const last = cwdOfLine(pending.toString("utf8"));
        return last === null ? { kind: "none" } : { kind: "found", cwd: last };
    }
    catch {
        return { kind: "unreadable" };
    }
    finally {
        try {
            closeSync(fd);
        }
        catch {
            // Nothing useful to do.
        }
    }
}
function cwdOfLine(line) {
    if (!line.includes('"cwd"'))
        return null;
    try {
        const record = JSON.parse(line);
        if (record === null || typeof record !== "object" || Array.isArray(record))
            return null;
        const cwd = record.cwd;
        return typeof cwd === "string" && cwd !== "" ? cwd : null;
    }
    catch {
        return null;
    }
}
// folder-check:end
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
    let slug = run.slugs.get(candidate.clone);
    if (slug === undefined) {
        slug = resolveRepoSlug(keys.worktree);
        run.slugs.set(candidate.clone, slug);
    }
    const quiet = ctx.now().getTime() - found.mtimeMs >= SESSION_LIVE_WINDOW_MS;
    const outcome = await run.close({
        home: ctx.home,
        env: ctx.env,
        nodeVersion: ctx.nodeVersion,
        agentId: candidate.agent,
        cwd: candidate.dir,
        url: run.url,
        credential: run.credential,
        projectKey: keys.worktree,
        redactionRoots: confinementRoots(keys),
        repoSlug: slug,
        sessionId: candidate.sessionId,
        transcriptPath: candidate.path,
        eof: found.size,
        // Sealed only when the transcript has been quiet for 30 minutes and it is not the session running this command.
        seal: quiet && !run.running.has(candidate.sessionId),
        allowNeverCaptured: true,
        completeSubagents: true,
    });
    return classify(outcome);
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
        slugs: new Map(),
    };
    const column = ROW_INDENT + Math.min(SLUG_MAX, Math.max(...plan.repos.map((repo) => repo.slug.length))) + COLUMN_GAP;
    const repoLine = (repo, text) => `${" ".repeat(ROW_INDENT)}${truncateMiddle(repo.slug, column - ROW_INDENT - COLUMN_GAP).padEnd(column - ROW_INDENT)}${text}`;
    writeLines(ctx.stdout, [...wrap(BACKFILL.runHeading(plan.total), 2)]);
    let uploaded = 0;
    let skipped = 0;
    let held = 0;
    let failed = 0;
    const heldRepos = [];
    for (const repo of plan.repos) {
        const tally = newTally();
        let slowShown = false;
        const timer = setTimeout(() => {
            // A static line, overwritten once when the repo finishes — and only where an overwrite is possible (§13.8).
            slowShown = true;
            ctx.stdout.write(`${paint(ctx.colour, "muted", repoLine(repo, "…"))}`);
        }, deps.slowAfterMs ?? SLOW_REPO_MS);
        let heldRepo = false;
        try {
            for (const candidate of repo.candidates) {
                if (signal.aborted)
                    break;
                // A repo whose owner has not approved capture is held whole: the rest of it is not even tried.
                const result = heldRepo ? { kind: "held" } : await uploadOne(run, candidate);
                if (result.kind === "uploaded")
                    tally.uploaded += 1;
                else if (result.kind === "skipped")
                    bump(tally.skipped, result.reason);
                else if (result.kind === "failed")
                    bump(tally.failed, result.reason);
                else if (result.kind === "held") {
                    tally.held += 1;
                    heldRepo = true;
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
        if (tally.held > 0)
            heldRepos.push(repo.slug);
        const role = tally.held > 0 || tally.stopped ? "warn" : "text";
        const line = paint(ctx.colour, role, repoLine(repo, tallyLine(tally)));
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
export async function backfillForConnect(ctx, repos, deps = {}) {
    const result = await runBackfill(ctx, { ...deps, fromConnect: true, scanMachine: () => ({ repos, notListed: NOTHING_NOT_LISTED }) });
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