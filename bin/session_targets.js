/**
 * `session_targets.ts` — what does this session belong to? (any-folder capture, R1 · R2 · R5 · R6 · R13 · R16 · R18)
 *
 * One module owns three things that used to be one hard-wired derivation ("the repo the turn ended in"):
 *
 *   1. **THE READER** — `scanTranscriptKeys`, the ONLY code that reads a field out of a transcript for attribution.
 *      D60 §D6 exception 1 was "one value (the first `cwd`), backfill only"; D2 · A widened it to two field kinds on
 *      every new record (each record's folder, and the path keys redaction already parses), in hooks and backfill, and
 *      D15 · A made that surface ONE function so one test file and one audit cover it. It parses only lines that name a
 *      key, keeps nothing but the set of strings found, and sends none of them anywhere.
 *   2. **THE RESOLVER** — `resolveTargets` turns evidence into `Target[]`: which granted repos (and, at the end of a
 *      repo-free session, which granted folder) this session's bytes go to, under which slug, ledger key and redaction
 *      roots.
 *   3. **THE TARGET RECORD** — per-session state that is sticky across firings: scan cursors, resolved roots, deferred
 *      roots, targets, undecided names.
 *
 * ## ⛔ What this module must never do
 *
 *   - **Never mint a fallback identity.** A spawn refused while naming a repo DEFERS that root to the next firing; it never
 *     becomes `local:<hash of the developer's path>` (R16 · D18, `spawn_budget.ts`'s own warning).
 *   - **Never write `grants.json`.** Hooks never write the consent file; this module only READS consent.
 *   - **Never decide a folder target before the end** (R18 · D21): only SessionEnd, `finalize` and backfill, after every
 *     line was read.
 */
import { createHash } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { agentForTranscript, DIALECTS, dialectFor, transcriptRoots } from "./agents/registry.js";
import { CALL_LOG_BUDGET_BYTES, DIR_OVERHEAD_BYTES, boundedId, bytesOf, storedBytes } from "./bounded_id.js";
import { nearestExistingPhysical, pathTooLong, physicalPath } from "./physical_path.js";
import { ALL_UNKNOWN, CodexTracker, DROPPED_CALL, IdMap, UNJUDGED_FILE, boundedIdEntries, carriesNames, poisonRepeated, folderFromValue, lookupIn, placesIn, ownFoldersOf, recordFolders } from "./codex_folders.js";
import { writeFileAtomic } from "./atomic_write.js";
import { captureStanding, normalizeSlug } from "./consent.js";
import { folderStandingOf } from "./folder_grants.js";
import { strictRepoSlug } from "./git.js";
import { isInside, isInsideAny, repoKeyDigest, sessionFileStem, sessionsRoot, sessionStatePath, sessionTargetsPath, subagentFileKey, subagentsDir, targetsDir, } from "./paths.js";
import { confinementRoots, resolveProjectKeys } from "./project.js";
import { rulesFor, rulesForTranscript } from "./redact.js";
import { fileState, loadSessionState } from "./state.js";
import { MIN_SPAWN_TIMEOUT_MS, spawnTimeoutMs } from "./spawn_budget.js";
/** Bytes read per `read(2)`. */
const SCAN_CHUNK_BYTES = 64 * 1024;
/**
 * The most bytes a firing STARTS scanning per stream (R16 · D18). A line that begins before this window is completed even
 * if it ends beyond it (R18 · D21: a long line is read whole), so a firing always advances at least one line.
 *
 * ⚠ ITS OWN CONSTANT, not `pending_bound.ts`'s: that one bounds a different scan (the promotion bound) with different
 * reasoning. The reasoning here is the spawn window: scanning feeds root resolution, and an unbounded first scan after an
 * upgrade (a 14 MB session) could spend a firing.
 */
export const EVIDENCE_SCAN_WINDOW_BYTES = 8 * 1024 * 1024;
/**
 * The longest single line the reader will hold to parse. Above it the line is SKIPPED for evidence, counted, and the
 * session becomes "unknown" for folder purposes (R18). Equal to the window by design: "a line over 8 MiB is unknown".
 */
export const EVIDENCE_MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Distinct strings kept per scan. A session that touched 50k files has named its repos long before this. */
const MAX_DISTINCT_HITS = 50_000;
/**
 * ⛔ The spec backfill's folder check uses: a top-level `cwd` and NOTHING else (the 10-24 one-value reading of D60 §D6
 * exception 1). The hook's resolver builds its own spec from the registry; backfill's gate must not widen when that does.
 */
export const TOP_LEVEL_CWD_ONLY = {
    cwdKeys: [{ path: ["cwd"] }],
    pathKeys: new Set(),
    nestedJsonKeys: new Set(),
};
// folder-check:begin
/**
 * Read `[from, …)` of a transcript and return the folders and paths its records name. ⛔ **THE ONLY TRANSCRIPT-FIELD
 * READER** (D15 · A). It starts a line only before `to`, finishes that line however long (up to `maxLineBytes`), and stops.
 * A line is parsed only if it mentions one of the keys; everything but the matching string values is discarded.
 *
 * ## ⛔ Bounded in what it READS, not only in what it parses (P1 review of A-T2)
 *
 * `maxReadBytes` caps the bytes read from disk in one call. A line the budget ends inside is NOT consumed: the cursor stays at
 * its start and a fresh firing re-reads it whole (every line up to `maxLineBytes` fits one fresh budget). A line over
 * `maxLineBytes` is never buffered: it is SKIPPED, counted once, and the scan keeps going to its newline; if the budget ends
 * first, `skipping` is returned with the cursor advanced, and the next call passes `continueSkipping` so it resumes the skip
 * instead of re-reading the line.
 *
 * `unreadable` (cannot open or stat) and a result with no hits are different facts and are told apart: a caller keeping sticky
 * targets treats `unreadable` as "no NEW targets this firing" and carries on (Q4).
 *
 * ⚠ Keys are matched by their plain names. A writer that escaped an ASCII key (`"file\u005fpath"`) would be missed: no real
 * transcript writer does (they emit keys verbatim), and the redactor, which parses the same lines, has the same reach.
 */
export function scanTranscriptKeys(path, from, to, spec, options = {}) {
    const maxLine = options.maxLineBytes ?? EVIDENCE_MAX_LINE_BYTES;
    // ⛔ PROGRESS IS GUARANTEED: a call that starts on a line start can always finish one maximal line (or skip a chunk of an
    // oversize one). With a budget smaller than `maxLine` a line between the two could never complete and every firing would
    // re-read it from its start. So the bound is the larger of the two, plus the chunk that crosses it.
    const maxRead = Math.max(options.maxReadBytes ?? EVIDENCE_SCAN_WINDOW_BYTES, maxLine + SCAN_CHUNK_BYTES);
    let fd;
    try {
        // ⛔ NON-BLOCKING, and REGULAR FILES ONLY. A FIFO or a socket named as a transcript would block `open(2)` forever when
        // nothing is writing (the hook would hang to its watchdog), and a device would read without end. `O_NONBLOCK` makes the open
        // return at once, and the `fstat` below refuses anything that is not a regular file before a byte is read. The fd stays
        // non-blocking, which changes nothing for a regular file.
        fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
    }
    catch {
        return { kind: "unreadable" };
    }
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile())
            return { kind: "unreadable" };
        const size = stat.size;
        const needles = needlesOf(spec, options.first === true);
        const seen = new Set();
        const hits = [];
        const maxHits = options.maxDistinctHits ?? MAX_DISTINCT_HITS;
        let capped = false;
        const note = (hit) => {
            const id = `${hit.kind}\u0000${hit.value}`;
            if (seen.has(id))
                return;
            if (seen.size >= maxHits) {
                capped = true;
                return;
            }
            seen.add(id);
            hits.push(hit);
        };
        const opens = [];
        const closes = [];
        const callState = { overflow: false };
        const codexState = spec.codexFolders === true
            ? {
                tracker: new CodexTracker({ turn: options.codex?.turn ?? null, sessions: options.codex?.sessions ?? [], cells: options.codex?.cells ?? [], openCalls: options.codex?.openCalls ?? [] }, options.codex?.calls ?? (() => undefined), CALL_BOUNDS, options.codex?.seen),
                changes: [],
                unknown: false,
                skipped: undefined,
            }
            : undefined;
        let oversizeLines = 0;
        /** Offset after the last line fully processed (or, while skipping, after the last byte consumed). */
        let processedTo = from;
        let parts = [];
        let partBytes = 0;
        let skipping = options.continueSkipping === true;
        let done = false;
        let readTotal = 0;
        let torn = false;
        const finishLine = (end) => {
            if (!skipping) {
                const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
                const calls = spec.trackCalls === true && options.first !== true ? { at: processedTo, opens, closes, state: callState, ...(codexState === undefined ? {} : { codex: codexState }) } : undefined;
                if (collectFromLine(line, spec, needles, options.first === true, note, calls))
                    capped = true;
            }
            parts = [];
            partBytes = 0;
            skipping = false;
            processedTo = end;
            // A line that STARTED before `to` is complete; the next one starts at or beyond it → stop. `first` stops on a cwd.
            if (processedTo >= to || (options.first === true && hits.length > 0))
                done = true;
        };
        const block = Buffer.alloc(SCAN_CHUNK_BYTES);
        let position = from;
        while (!done && position < size && (processedTo < to || skipping)) {
            if (readTotal >= maxRead)
                break;
            const n = readSync(fd, block, 0, Math.min(block.length, size - position), position);
            if (n <= 0)
                break;
            readTotal += n;
            let cursor = 0;
            while (cursor < n && !done) {
                const newline = block.subarray(0, n).indexOf(0x0a, cursor);
                const segmentEnd = newline === -1 ? n : newline;
                const segmentBytes = segmentEnd - cursor;
                if (!skipping) {
                    if (partBytes + segmentBytes > maxLine) {
                        // Entering a skip: counted ONCE, here, and the partial buffer is dropped, never grown further.
                        skipping = true;
                        oversizeLines += 1;
                        parts = [];
                        partBytes = 0;
                        // C50 (4): a Codex line that was never read may have been a `turn_context` for another folder: the turn folder is UNKNOWN from this line until
                        // the next readable header, and the line itself cannot be placed.
                        if (codexState !== undefined) {
                            if (codexState.tracker.turn !== null)
                                codexState.changes.push({ at: processedTo, dir: null });
                            codexState.tracker.turn = null;
                            codexState.unknown = true;
                            // C56 (8): a skipped line may have held a call; an output whose call is unknown after it is unjudged (the stream's first skip is kept, sticky).
                            codexState.skipped = codexState.skipped ?? processedTo;
                        }
                    }
                    else if (segmentBytes > 0) {
                        parts.push(Buffer.from(block.subarray(cursor, segmentEnd)));
                        partBytes += segmentBytes;
                    }
                }
                if (newline === -1) {
                    cursor = n;
                }
                else {
                    finishLine(position + newline + 1);
                    cursor = newline + 1;
                }
            }
            position += n;
            // Mid-skip, every byte consumed is progress (nothing is buffered), so the cursor follows it.
            if (skipping && !done)
                processedTo = position;
        }
        // The tail after the last newline. While the session lives it is a line still being written: left for the next firing.
        // When the caller says the file is final it counts ONLY if it is a complete record (it parses); a torn tail is not
        // consumed, so the stream reads as unfinished (P1 review) instead of being declared read.
        if (!done && options.includeUnterminatedTail === true && position >= size && !skipping && partBytes > 0) {
            const text = (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString("utf8");
            let complete = true;
            try {
                JSON.parse(text);
            }
            catch {
                complete = false;
            }
            if (complete)
                finishLine(size);
            else
                torn = true;
        }
        return {
            kind: "ok",
            hits,
            scannedTo: processedTo,
            oversizeLines,
            capped,
            skipping,
            torn,
            size,
            calls: { opens, closes, overflow: callState.overflow },
            folders: {
                changes: codexState?.changes ?? [],
                sessions: codexState === undefined ? [] : [...codexState.tracker.sessions],
                cells: codexState === undefined ? [] : [...codexState.tracker.cells],
                unknown: codexState?.unknown ?? false,
                ...(codexState?.skipped === undefined ? {} : { skipped: codexState.skipped }),
            },
        };
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
/** The substrings a line must contain to be worth parsing. A line naming none of the keys is never parsed. */
function needlesOf(spec, cwdOnly) {
    const names = new Set();
    for (const key of spec.cwdKeys) {
        const leaf = key.path[key.path.length - 1];
        if (leaf !== undefined)
            names.add(leaf);
    }
    if (!cwdOnly)
        for (const name of spec.pathKeys)
            names.add(name);
    // A nested JSON document is an ESCAPED string inside the record, so its keys appear as `\"workdir\"`; the bare name matches both.
    if (!cwdOnly)
        for (const name of spec.nestedJsonKeys)
            names.add(name);
    // C44 (2): when calls are tracked, a line that holds a tool call or its result is parsed whatever else it names, and so is a line with a `\u` escape (an
    // escaped key, `"file_path"`, is decoded by the parse and judged after).
    if (!cwdOnly && spec.trackCalls === true)
        for (const name of ["tool_use", "tool_result", "\\u"])
            names.add(name);
    return [...names];
}
/** Returns true when it could NOT look at everything (the depth limit): the caller treats that like a capped scan. */
/**
 * The folders ONE parsed record names, by the dialect's `cwdKeys`. ⛔ **Part of the single transcript-field reader**: record
 * isolation (R17) asks this same function which folder a record ran in, so "where a record ran" has one definition.
 */
export function cwdsOfRecord(record, cwdKeys) {
    const out = [];
    for (const key of cwdKeys) {
        if (key.types !== undefined && !(typeof record.type === "string" && key.types.includes(record.type)))
            continue;
        let at = record;
        for (const step of key.path) {
            if (at === null || typeof at !== "object" || Array.isArray(at)) {
                at = undefined;
                break;
            }
            at = at[step];
        }
        if (typeof at === "string" && at !== "") {
            // A finished command item names its folder as a `file://` URL (Codex): a path is what everything downstream compares.
            const folder = at.startsWith("file://") ? folderFromValue(at) : at;
            // C75 (F1): a folder longer than any path the kernel could have opened is not a folder (the ONE guard, `pathTooLong`): it is dropped at the source, like a
            // non-string cwd, so it is never stored as `launchFolder` or noted as a candidate root. (Judged as before for isolation: a path that long names no work tree.)
            if (folder !== null && folder !== "" && !pathTooLong(folder))
                out.push(folder);
        }
    }
    return out;
}
function collectFromLine(line, spec, needles, cwdOnly, note, calls) {
    if (spec.codexFolders !== true && !needles.some((needle) => line.includes(needle)))
        return false;
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return false;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return false;
    const record = parsed;
    // C49 (7): a Codex record's own folder is read by the ONE definition the rule uses (`ownFoldersOf`, `file://` decoded, whatever the record's type).
    for (const value of spec.codexFolders === true ? ownFoldersOf(record) : cwdsOfRecord(record, spec.cwdKeys))
        note({ kind: "cwd", value });
    if (cwdOnly)
        return false;
    const unjudged = calls !== undefined ? noteCalls(record, spec, calls, false, note) : false;
    return walkForPaths(record, spec, note, 0) || unjudged;
}
/**
 * Depth bound: a transcript record nests a handful of levels. Anything deeper is NOT silently ignored: the walk reports that it
 * stopped looking, and the caller treats the scan as incomplete (a repo named only that deep would otherwise read as "no repo").
 */
const MAX_WALK_DEPTH = 24;
function walkForPaths(node, spec, note, depth) {
    if (node === null || typeof node !== "object")
        return false;
    if (depth > MAX_WALK_DEPTH)
        return true;
    let truncated = false;
    if (Array.isArray(node)) {
        for (const item of node)
            if (walkForPaths(item, spec, note, depth + 1))
                truncated = true;
        return truncated;
    }
    for (const [key, value] of Object.entries(node)) {
        if (typeof value === "string") {
            if (spec.pathKeys.has(key) && value !== "")
                note({ kind: "path", value });
            else if (spec.nestedJsonKeys.has(key) && walkNested(value, spec, note, depth + 1))
                truncated = true;
        }
        else if (walkForPaths(value, spec, note, depth + 1)) {
            truncated = true;
        }
    }
    return truncated;
}
function walkNested(text, spec, note, depth) {
    try {
        return walkForPaths(JSON.parse(text), spec, note, depth);
    }
    catch {
        // Not JSON after all: nothing to read.
        return false;
    }
}
/**
 * Part (b): one Codex record's contribution to the checkpoint, through the SAME tracker the delivery's observer uses. A `session_meta` / `turn_context`
 * cwd that differs from the turn folder in force is a change point; EVERY call is opened with the folder(s) it ran in (`[]` when they cannot be told) and
 * the tool it named, and the output that carries its `call_id` closes it and teaches the session and cell maps. A record that cannot be placed marks the
 * session's folders unknown. Folders a call names that the key walk cannot see (an `exec` program's `workdir`, a patch's files) are also evidence for the
 * resolver: they are noted as paths.
 */
function noteCodex(record, calls, note) {
    const cx = calls.codex;
    if (cx === undefined)
        return false;
    const before = cx.tracker.turn;
    const step = cx.tracker.step(record, calls.at);
    if (step.turnChange !== undefined && step.turnChange !== before)
        cx.changes.push({ at: calls.at, dir: step.turnChange });
    if (step.open !== undefined) {
        calls.opens.push({
            id: step.open.id,
            at: calls.at,
            paths: step.open.paths,
            tool: step.open.tool,
            ...(step.open.files === undefined ? {} : { files: step.open.files }),
            // C56 (1): the checkpoint does not keep a call's evidence, only that it HAD names: evicting it must not lose them.
            ...(carriesNames(step.open) ? { named: true } : {}),
        });
        // C53: the folders and files a call names are evidence even when its placement is unknown.
        if (note !== undefined)
            for (const dir of [...step.open.paths, ...(step.open.evidence ?? [])])
                note({ kind: "path", value: dir });
    }
    if (step.close !== undefined)
        calls.closes.push({ id: step.close, at: calls.at });
    if (step.unknown)
        cx.unknown = true;
    // C54 (1): a call that named more readable places than the client keeps cannot vouch for what it named: the evidence is incomplete, like a dropped hit
    // (the session is multi). (A call with a path it could not resolve carries UNJUDGED_FILE, but names nothing extra: it is only withheld.)
    // C75 (9): an id map collapsed an entry (its byte budget): evidence was lost, like a call that names more places than are kept.
    return step.open?.overflow === true || step.collapsed === true;
}
/**
 * C40 (1): the calls of one Claude record. A `tool_use` block whose input holds a path key is OPENED with the paths it names; a `tool_result` block
 * CLOSES the call with its `tool_use_id`. A call that names no file is not recorded (its result is the stated residual).
 */
function noteCalls(record, spec, calls, 
/** C44 (7b): also record a call that names no file (empty `paths`). The checkpoint does not; the in-memory observer does. */
all = false, 
/** The evidence note, for a dialect whose calls carry folders the key walk cannot see (Codex's JavaScript `exec` programs). */
note) {
    if (spec.codexFolders === true)
        return noteCodex(record, calls, note);
    const message = record.message;
    if (message === null || typeof message !== "object")
        return false;
    const blocks = message.content;
    if (!Array.isArray(blocks))
        return false;
    for (const block of blocks) {
        if (block === null || typeof block !== "object")
            continue;
        const b = block;
        if (b.type === "tool_use" && typeof b.id === "string") {
            const paths = new Set();
            // C75 (F2): a path longer than any the kernel could have opened is never stored (the ONE guard, `pathTooLong`); the call is marked INCOMPLETE instead, so
            // its result stays withheld in every copy (the C44 (4) state: the call named something the client cannot vouch for).
            let tooLong = false;
            const truncated = walkForPaths(b.input, spec, (hit) => {
                if (hit.kind !== "path")
                    return;
                if (pathTooLong(hit.value))
                    tooLong = true;
                else
                    paths.add(hit.value);
            }, 0);
            // C75 (8): a call that alone names more path text than the log may store is not stored either: INCOMPLETE, its result is withheld.
            const overBudget = bytesOf([...paths]) > CALL_LOG_BUDGET_BYTES;
            if (overBudget)
                paths.clear();
            const incomplete = truncated || tooLong || overBudget;
            // C44 (4): a call nested past the depth keeps whatever paths it showed, marked INCOMPLETE: its result is unknown, and the log is not overflowed for it.
            if (paths.size > 0 || incomplete || all)
                calls.opens.push({ id: boundedId(b.id), at: calls.at, paths: [...paths], ...(incomplete ? { incomplete: true } : {}) });
        }
        else if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            calls.closes.push({ id: boundedId(b.tool_use_id), at: calls.at });
        }
    }
    return false;
}
// ===========================================================================
// The target record, the resolver
// ===========================================================================
/**
 * How many firings may fail to name a root that has a `.git` before it is recorded `nonrepo`. A `.git` that `git rev-parse`
 * will not answer for (dubious ownership, a corrupt repo, a stale worktree file, a timeout) is evidence of a repo we cannot
 * name; it is retried a few times (a timeout heals) and then stops costing a slot per firing. Either way it STILL counts as a
 * named repo for R6's folder rule: `nonrepo` here means "unnameable", never "not a repo".
 */
export const MAX_NAMING_FAILURES = 3;
/** Candidate roots resolved per firing (R16 · D18). Each costs up to four spawns; the rest wait for the next firing. */
export const MAX_NEW_ROOTS_PER_FIRING = 8;
/** The turn folder at the END of a stream's persisted timeline (where a resumed scan picks up), or null. */
function lastFolderOf(log) {
    const changes = log?.changes;
    return changes === undefined || changes.length === 0 ? null : changes[changes.length - 1].dir;
}
/** C40 (1): the most calls still waiting for a result that one stream's checkpoint keeps; the oldest is dropped (and the log is `overflowed`). */
export const MAX_OPEN_CALLS = 256;
/** C44 (7a): the most dropped open-call ids a log remembers before it falls back to the sticky `overflowed`. */
export const MAX_DROPPED_IDS = 4096;
/** Calls whose result was seen, kept until every copy is past them (a late target starts at offset 0); the oldest is dropped (the `horizon` rises). */
export const MAX_CLOSED_CALLS = 4096;
/** The call bounds the Codex tracker mirrors, so the scan and the delivery agree with the checkpoint (C49 (9)). */
const CALL_BOUNDS = { open: MAX_OPEN_CALLS, closed: MAX_CLOSED_CALLS, dropped: MAX_DROPPED_IDS };
/** Part (b): the most turn-folder change points one stream's timeline keeps; the oldest is dropped, and a position before the first kept point is unknown. */
export const MAX_FOLDER_CHANGES = 4096;
/**
 * C75 (9): the timeline keeps at most `MAX_FOLDER_CHANGES` change points AND `CALL_LOG_BUDGET_BYTES` of folder text (4,096 points of 4,096 bytes are 16 MiB): the OLDEST points are
 * dropped, and a position before the first kept point is unknown (the existing rule), so nothing is silently judged by a point that is gone.
 */
export function boundedChanges(changes) {
    let from = Math.max(0, changes.length - MAX_FOLDER_CHANGES);
    let bytes = 0;
    const cost = (change) => DIR_OVERHEAD_BYTES + Buffer.byteLength(change.dir ?? "", "utf8");
    for (let i = from; i < changes.length; i += 1)
        bytes += cost(changes[i]);
    while (bytes > CALL_LOG_BUDGET_BYTES && from < changes.length - 1) {
        bytes -= cost(changes[from]);
        from += 1;
    }
    return changes.slice(from).map((change) => ({ at: change.at, dir: change.dir }));
}
export function emptyTargetRecord(sessionId) {
    return {
        v: 1,
        sessionId,
        launchFolder: null,
        scan: {},
        calls: {},
        folders: {},
        oversize: false,
        failures: {},
        roots: {},
        unresolved: [],
        ledgerOnly: [],
        targets: [],
        undecided: [],
        stopped: {},
        settled: false,
        transcriptPath: null,
        firedAt: 0,
        updatedAt: 0,
    };
}
/** The record, or null when absent or unreadable. ⚠ Null is a RESYNC, not an error: the scan restarts and ledgers are adopted. */
export function loadTargetRecord(home, sessionId) {
    let raw;
    try {
        raw = readFileSync(sessionTargetsPath(home, sessionId), "utf8");
    }
    catch {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || parsed.v !== 1 || parsed.sessionId !== sessionId)
            return null;
        return { ...emptyTargetRecord(sessionId), ...parsed };
    }
    catch {
        return null;
    }
}
/** Atomic (temp + rename), mode 0600. ⛔ The CALLER holds the one per-session lock (O5); this module never takes it. */
export function saveTargetRecord(home, record) {
    try {
        const path = sessionTargetsPath(home, record.sessionId);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileAtomic(path, `${JSON.stringify(record)}\n`, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** Every session's record on this machine, with its file and mtime, for the idle-session drain (R19). Unreadable ones are skipped. */
export function listTargetRecords(home) {
    let entries;
    try {
        entries = readdirSync(targetsDir(home));
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.endsWith(".targets"))
            continue;
        const path = join(targetsDir(home), entry);
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            if (parsed === null || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.sessionId !== "string")
                continue;
            found.push({ path, mtimeMs: statSync(path).mtimeMs, record: { ...emptyTargetRecord(parsed.sessionId), ...parsed } });
        }
        catch {
            continue;
        }
    }
    return found;
}
/** Names recent sessions' evidence left undecided, for `vibecommit status` (names only: no transcript is opened). */
export function readUndecidedNames(home, sinceMs) {
    let entries;
    try {
        entries = readdirSync(targetsDir(home));
    }
    catch {
        return [];
    }
    const latest = new Map();
    for (const entry of entries) {
        if (!entry.endsWith(".targets"))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(join(targetsDir(home), entry), "utf8"));
        }
        catch {
            continue;
        }
        for (const u of parsed.undecided ?? []) {
            if (typeof u?.name !== "string" || typeof u.at !== "number" || u.at < sinceMs)
                continue;
            const id = `${u.kind}\u0000${u.name}`;
            const have = latest.get(id);
            if (have === undefined || u.at > have.at)
                latest.set(id, u);
        }
    }
    return [...latest.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}
/**
 * The folder targets that were stopped (C3: `folder_repository_forbidden`) in the last `sinceMs`, newest per folder, for
 * `vibecommit status`. Reads only the per-session target records through the same directory listing the drain and
 * `readUndecidedNames` use: no transcript is opened, and a record the drain has forgotten is simply not there.
 */
export function readStoppedFolders(home, sinceMs) {
    let entries;
    try {
        entries = readdirSync(targetsDir(home));
    }
    catch {
        return [];
    }
    const latest = new Map();
    for (const entry of entries) {
        if (!entry.endsWith(".targets"))
            continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(join(targetsDir(home), entry), "utf8"));
        }
        catch {
            continue;
        }
        const stopped = parsed.stopped;
        if (stopped === null || typeof stopped !== "object")
            continue;
        for (const target of parsed.targets ?? []) {
            if (target?.kind !== "folder" || typeof target.folder !== "string" || typeof target.slug !== "string")
                continue;
            const stop = stopped[stopKeyOf(target)];
            if (stop === undefined || typeof stop.at !== "number" || typeof stop.code !== "string" || stop.at < sinceMs)
                continue;
            const have = latest.get(target.folder);
            if (have === undefined || stop.at > have.at)
                latest.set(target.folder, { folder: target.folder, slug: target.slug, at: stop.at, code: stop.code });
        }
    }
    return [...latest.values()].sort((a, b) => (a.folder < b.folder ? -1 : 1));
}
/**
 * ⛔ A FOLDER TARGET'S LEDGER KEY IS NAMESPACED (C17 #1): `folder:<realpath>`, never the bare path. A ledger is keyed by the string
 * its digest is taken of, and a work tree's ledger key IS its path; if the folder later became a git repo and the session resumed,
 * the repo target would have adopted the folder's ledger and sent its offsets to the repo's server stream. A prefixed key can never
 * equal a work-tree path, so the two can never collide.
 */
export const FOLDER_LEDGER_PREFIX = "folder:";
export function folderLedgerKey(realLaunchFolder) {
    return `${FOLDER_LEDGER_PREFIX}${realLaunchFolder}`;
}
/** `local:folder:<first 12 lowercase hex of sha256(realpath(launch folder))>` — C2. A no-repo remote keeps `local:<12 hex>`. */
export function folderSlug(realLaunchFolder) {
    return `local:folder:${createHash("sha256").update(realLaunchFolder).digest("hex").slice(0, 12)}`;
}
/** Everything `resolveTargets` needs from its caller. The `seams` are for tests; production passes none. */
/** The caller's session lock was lost while it resolved targets (C25). Nothing was written. */
export class LockLostError extends Error {
    constructor() {
        super("the session writer lock is no longer ours");
        this.name = "LockLostError";
    }
}
/**
 * Every `agent-*.jsonl` under this session's `subagents/`, oldest first, each confined to the transcript roots.
 *
 * ⛔ **THE ONE COPY of sub-agent discovery** (A-T3 deletes `hooks/entry.ts`'s and imports this): `agent-*.jsonl`, never
 * `agent-*` (the `.meta.json` sidecar would double every upload); every entry gated by `isInsideAny` so a symlink cannot walk
 * out; the glob runs only for a dialect that declares `discover`.
 */
export function findSubagentTranscripts(home, env, transcriptPath) {
    return findSubagentTranscriptsChecked(home, env, transcriptPath).found;
}
/**
 * `findSubagentTranscripts` that also says whether the directory could not be LISTED (C17 #2): ENOENT is "no delegated streams",
 * but EACCES or EIO is "unknown", and the resolver must not read unknown as empty (a folder could be authorized over a stream it
 * never saw).
 */
export function findSubagentTranscriptsChecked(home, env, transcriptPath) {
    if (dialectFor(agentForTranscript(home, env, transcriptPath)).delegatedTranscripts !== "discover")
        return { found: [], listFailed: false };
    const dir = subagentsDir(transcriptPath);
    if (dir === null)
        return { found: [], listFailed: false };
    const roots = transcriptRoots(home, env);
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch (error) {
        return { found: [], listFailed: error.code !== "ENOENT" };
    }
    const found = [];
    for (const entry of entries) {
        const fileKey = subagentFileKey(entry);
        if (fileKey === null)
            continue;
        const path = join(dir, entry);
        if (!isInsideAny(roots, path))
            continue;
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size === 0)
                continue;
            found.push({ path, fileKey, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        catch {
            // Vanished between readdir and stat.
        }
    }
    return { found: found.sort((a, b) => a.mtimeMs - b.mtimeMs), listFailed: false };
}
/**
 * Whether the dialect that owns this transcript can keep one repository's copy free of another's records (`isolatesContentRecords`).
 * A transcript outside every dialect's root, or inside more than one, is NOT isolatable: fail closed.
 */
export function dialectIsolates(home, env, transcriptPath) {
    // Which dialect OWNS the transcript is a policy question, so it must not depend on the file still existing (`isInside` resolves real
    // paths and answers "outside" for a vanished file, which would flip a session's capability mid-session): the real-path test OR a
    // plain prefix test. Confinement itself (symlinks out of the roots) is `admitsTranscript`'s job at every entry, not this function's.
    const matches = DIALECTS.filter((dialect) => {
        const root = dialect.transcriptRoot(home, env);
        return isInside(root, transcriptPath) || transcriptPath.startsWith(`${root}/`);
    });
    return matches.length === 1 && matches[0].isolatesContentRecords;
}
/** The evidence spec for a transcript: redaction's key lists (A3: one list) plus the dialect's `cwdKeys`. */
export function evidenceSpecFor(home, env, transcriptPath) {
    const matches = DIALECTS.filter((dialect) => isInside(dialect.transcriptRoot(home, env), transcriptPath));
    const rules = matches.length === 1 ? rulesFor(matches[0].redaction) : rulesForTranscript(home, env, transcriptPath);
    return {
        cwdKeys: matches.length === 1 ? matches[0].cwdKeys : DIALECTS.flatMap((dialect) => dialect.cwdKeys),
        pathKeys: rules.pathKeys,
        nestedJsonKeys: rules.nestedJsonKeys,
        // C40 (1): Claude's results can name no file (an image Read), so its calls are tracked; the other dialects are not scanned for evidence.
        ...(matches.length === 1 && matches[0].redaction === "claude-code" ? { trackCalls: true } : {}),
        // Part (b): Codex records name their folder on few types; the scan keeps the turn-folder timeline and every call.
        ...(matches.length === 1 && matches[0].redaction === "codex-cli" ? { trackCalls: true, codexFolders: true } : {}),
    };
}
/**
 * The nearest existing ancestor of `path`, physically resolved (`/tmp` and `/private/tmp` are one place; a deleted file maps up). C70: `..` is resolved AFTER the
 * links before it (`physicalPath`), as the kernel does, never lexically first.
 */
function nearestExisting(path) {
    // C49 (8): a component that EXISTS but cannot be resolved (a dangling symlink, an unreadable folder) is never ascended past: `null`, and the caller fails closed.
    return nearestExistingPhysical(path);
}
/**
 * C50 (3): is this an absolute place that EXISTS but cannot be resolved (a dangling link, an unreadable folder)? That is not "in no work tree": nobody can say
 * which tree it is in, so a record placed there is UNKNOWN and evidence naming it makes the session multi (the status of the session is unknown).
 */
function unresolvable(path, cache) {
    const known = cache?.get(path);
    if (known !== undefined)
        return known;
    const verdict = isAbsolute(path) && nearestExisting(path) === null;
    cache?.set(path, verdict);
    return verdict;
}
/**
 * The work tree a place belongs to, found by `stat` alone (no spawn): the nearest ancestor holding `.git` (a directory, or
 * the file a linked worktree and a submodule have). ⛔ NEAREST WINS, so a nested repo beats its parent (Q4).
 */
function workTreeRootOf(path, cache) {
    if (!isAbsolute(path))
        return null;
    const start = nearestExisting(path);
    if (start === null)
        return null;
    const walked = [];
    let dir = start;
    try {
        if (!statSync(start).isDirectory())
            dir = dirname(start);
    }
    catch {
        return null;
    }
    let found = null;
    for (;;) {
        const known = cache.get(dir);
        if (known !== undefined) {
            found = known;
            break;
        }
        walked.push(dir);
        if (existsSync(join(dir, ".git"))) {
            found = dir;
            break;
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    for (const visited of walked)
        cache.set(visited, found);
    return found;
}
const idMaps = new WeakMap();
function idMapsOf(log) {
    if (log === undefined)
        return undefined;
    let known = idMaps.get(log);
    if (known === undefined) {
        known = { sessions: new Map(log.sessions ?? []), cells: new Map(log.cells ?? []) };
        idMaps.set(log, known);
    }
    return known;
}
/** The id entries as they stood at `start`: only what was learned before it (an unknown mark only if it was set before it). */
function idEntriesBefore(entries, start) {
    const out = [];
    for (const [id, entry] of entries ?? []) {
        const dirs = entry.dirs.filter((learned) => learned.at < start);
        const unknownAt = entry.unknownAt !== undefined && entry.unknownAt < start ? entry.unknownAt : undefined;
        // C56 (audit): a TOMBSTONE (or the whole-map mark) replaced an entry that was learned before `start` and evicted after it: the entry's folders are gone from
        // the log, but the id is known to have existed, so it is unknown FROM `start` (carrying the files it kept), never absent.
        if (start > 0 && unknownAt === undefined && (entry.tomb === true || id === ALL_UNKNOWN)) {
            out.push([
                id,
                {
                    dirs: [],
                    unknownAt: start - 1,
                    ...(entry.tomb === true ? { tomb: true } : {}),
                    ...(entry.files === undefined ? {} : { files: entry.files }),
                    ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
                },
            ]);
            continue;
        }
        if (dirs.length === 0 && unknownAt === undefined)
            continue;
        // C55 (1): the files and evidence of the UNKNOWN calls that announced the id carry no offset of their own, so ALL of them are carried (a file learned after
        // `start` is learned again by the replay; carrying it early only withholds more, which fails closed).
        out.push([
            id,
            {
                dirs,
                ...(unknownAt === undefined ? {} : { unknownAt }),
                ...(entry.tomb === true && unknownAt !== undefined ? { tomb: true } : {}),
                ...(entry.files === undefined ? {} : { files: entry.files }),
                ...(entry.evidence === undefined ? {} : { evidence: entry.evidence }),
            },
        ]);
    }
    return out;
}
/**
 * A checkpoint entry as the tracker's `CallInfo` (one place, so no field a placement needs is dropped on the way). EVERY CallEntry field is accounted for:
 * `id` is the key; `tool`, `paths`, `files` and `named` are carried (`named` is what eviction consults, C61 (2)); `at` and `closedAt` only select WHICH entries
 * are open at a position (`openCallsAt`, `persistedCodexEnv`), a call table has no position of its own; `incomplete` is set only for a Claude call (a Codex scan
 * never marks it), and Claude calls do not go through the tracker.
 */
function callInfoOf(entry) {
    return {
        tool: entry.tool ?? "",
        paths: entry.paths,
        ...(entry.files === undefined ? {} : { files: entry.files }),
        ...(entry.named === true ? { named: true } : {}),
    };
}
/** The calls of a persisted log still waiting for an output at `start`, oldest first, as the tracker holds them. */
function openCallsAt(log, start) {
    const out = [];
    for (const entry of log?.entries ?? []) {
        if (entry.at < start && (entry.closedAt === null || entry.closedAt >= start)) {
            out.push([entry.id, callInfoOf(entry)]);
        }
    }
    return out;
}
/**
 * C63: the ONE by-id lookup of the checkpoint's call table for placement. It returns the call as the tracker's `CallInfo`: the entry opened BEFORE `position` (at or
 * before it when `inclusive`: the call record being judged), else `DROPPED_CALL` when the checkpoint evicted the id carrying names (or that set overflowed, C56 (1)),
 * else undefined. A call opened at or after `position` is the future: it never places a record before it. Callers: the persisted env's callFolders and callFiles
 * (exclusive at the record) and ownCall (inclusive), the seeded observer's `known` (exclusive at the observer's start) and the scan's `calls` (exclusive at the scan's
 * start). Nothing else looks an entry up by id for placement.
 */
function persistedCall(log, id, position, inclusive) {
    const entry = entryOf(log, id);
    if (entry !== undefined && (inclusive ? entry.at <= position : entry.at < position))
        return callInfoOf(entry);
    return droppedCallInfo(log, id);
}
/** C62: a call log's entries by id, built once per log (a log is immutable once persisted; an id has at most one entry): O(1) per lookup, not a scan per record. */
const entryMaps = new WeakMap();
function entryOf(log, id) {
    if (log === undefined)
        return undefined;
    let map = entryMaps.get(log);
    if (map === undefined) {
        map = new Map(log.entries.map((entry) => [entry.id, entry]));
        entryMaps.set(log, map);
    }
    return map.get(id);
}
/** C62: the ids a call log has seen, built once per log: an entry's open offset, and the ids it dropped, dropped with names, or pruned. */
const seenIdMaps = new WeakMap();
/**
 * Has the checkpoint seen a call with this id? `before` (an observer's start): only an entry opened before it counts, because the observer REPLAYS the bytes the scan
 * already folded; an observer that starts at byte 0 replays everything and sees every id itself, so nothing counts. The scan passes no `before` (it reads new bytes
 * only, so every id in the log is from an earlier firing).
 */
function seenCallId(log, id, before) {
    if (log === undefined)
        return false;
    if (before === 0)
        return false;
    let seen = seenIdMaps.get(log);
    if (seen === undefined) {
        seen = { entries: new Map(log.entries.map((entry) => [entry.id, entry.at])), gone: new Set([...(log.droppedIds ?? []), ...(log.droppedNamed ?? []), ...(log.prunedIds ?? [])]) };
        seenIdMaps.set(log, seen);
    }
    const at = seen.entries.get(id);
    if (at !== undefined && (before === undefined || at < before))
        return true;
    return seen.gone.has(id);
}
/** `DROPPED_CALL` when the checkpoint evicted call `id` carrying files or evidence (or that set overflowed), else undefined. */
function droppedCallInfo(log, id) {
    if (log === undefined)
        return undefined;
    if (log.droppedNamedAll === true)
        return DROPPED_CALL;
    if (log.droppedNamed === undefined)
        return undefined;
    let set = droppedNamedSets.get(log);
    if (set === undefined) {
        set = new Set(log.droppedNamed);
        droppedNamedSets.set(log, set);
    }
    return set.has(id) ? DROPPED_CALL : undefined;
}
/** C62: membership of `droppedNamed` per call log, built once (a log is immutable once persisted). */
const droppedNamedSets = new WeakMap();
/** The seeded observer's `known`: the call table as it stood before the observer's `start` (see `persistedCall`). */
function persistedCallInfo(isolation, fileKey, id, start) {
    return persistedCall(isolation.calls === undefined || isolation.calls === null ? undefined : isolation.calls[fileKey], id, start, false);
}
/**
 * C56 (8)(9): may a call that is unknown at `position` have been LOST (a skipped line, a pruned or dropped entry) rather than never made? `viewStart` is where
 * the view judging the record began reading the stream (the observer's start; `Infinity` for the persisted checkpoint alone): a view that began at byte 0 saw
 * every call; one that began later cannot see a call the checkpoint no longer holds.
 */
function callsLostAt(isolation, fileKey, position, viewStart) {
    const skipped = isolation.folders?.[fileKey]?.skipped;
    if (skipped !== undefined && skipped < position && viewStart > skipped)
        return true;
    if (isolation.calls === undefined || isolation.calls === null)
        return false;
    const log = isolation.calls[fileKey];
    if (log === undefined)
        return viewStart > 0;
    return position <= log.horizon && viewStart > 0;
}
/** What places a Codex record from the persisted checkpoint alone (a record before the observer's start, or a delivery with no observer). */
function persistedCodexEnv(isolation, fileKey, position) {
    const log = isolation.folders?.[fileKey];
    const maps = idMapsOf(log);
    return {
        turnFolder: () => lastChangeAtOrBefore(log?.changes, position),
        callFolders: (id) => {
            const logCalls = isolation.calls === undefined || isolation.calls === null ? undefined : isolation.calls[fileKey];
            // C56 (1): a call the checkpoint evicted carrying files is found as `DROPPED_CALL` (no folders, the unjudged mark).
            return persistedCall(logCalls, id, position, false)?.paths;
        },
        callFiles: (id) => {
            const logCalls = isolation.calls === undefined || isolation.calls === null ? undefined : isolation.calls[fileKey];
            return persistedCall(logCalls, id, position, false)?.files ?? [];
        },
        ownCall: (id) => {
            const logCalls = isolation.calls === undefined || isolation.calls === null ? undefined : isolation.calls[fileKey];
            return persistedCall(logCalls, id, position, true);
        },
        // C49 (2): only what was learned BEFORE the record being judged.
        session: (id) => lookupIn(maps?.sessions, id, position),
        cell: (id) => lookupIn(maps?.cells, id, position),
        sessionPlaces: () => placesIn(maps?.sessions, position),
        callsLost: () => callsLostAt(isolation, fileKey, position, Number.POSITIVE_INFINITY),
    };
}
/** The directory of the last change point at or before `position` (binary search), or null when the timeline has none that early. */
function lastChangeAtOrBefore(changes, position) {
    if (changes === undefined || changes.length === 0)
        return null;
    let lo = 0;
    let hi = changes.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (changes[mid].at <= position) {
            found = mid;
            lo = mid + 1;
        }
        else {
            hi = mid - 1;
        }
    }
    return found === -1 ? null : changes[found].dir;
}
/** The most bytes a delivery will re-read to observe the gap between the scan cursor and where its span starts. Beyond it the copy fails closed. */
const MAX_PAST_GAP_BYTES = 64 * 1024 * 1024;
/** The gap is read in chunks of at most this many bytes, so the hook's budget is checked between them (a synchronous read cannot be preempted). */
const PAST_GAP_CHUNK_BYTES = 4 * 1024 * 1024;
/** What one chunk is assumed to cost, for deciding whether the remaining budget can cover it (measured: about 8 ms per MiB idle, several times that under load). */
const PAST_GAP_CHUNK_COST_MS = 150;
/** C44 (6): a gap line longer than this is not parsed by the observer; the stream fails closed for the firing (the corpus has 0 lines over 8 MiB). */
const PAST_GAP_MAX_LINE_BYTES = 4 * 1024 * 1024;
/** C44 (6): the deadline is checked before parsing any gap line longer than this. */
const PAST_GAP_CHECK_LINE_BYTES = 256 * 1024;
/**
 * C42/C43: the observer for one delivery. `foreign` is the same stat-only test as record isolation (`workTreeRootOf`, nearest existing ancestor for a
 * gone path, no spawn, cached); a path outside every work tree (the global CLAUDE.md, /tmp) is NOT another work tree and sets nothing.
 *
 * A stream needs it when the read goes past the scan cursor (C42: calls and a second work tree the checkpoint never saw), and when the read reaches a
 * position at or below the call HORIZON (C43: calls were pruned once every then-existing copy was past them, so a copy created later, a repo granted
 * after the fact, cannot judge a result by the log). Then it observes its OWN delivered bytes from the first one it delivers, in order. A call seen
 * earlier gives its paths; one not seen gives `none` only when the observer started at byte 0 of the stream (it saw every byte before the result);
 * a copy that starts mid-stream below the horizon keeps the persisted verdict (`unknown`), so a call the 4,096-entry cap dropped stays withheld.
 */
export function pastCursorOf(isolation, cursors, options = {}) {
    const maxGapBytes = options.maxGapBytes ?? MAX_PAST_GAP_BYTES;
    const chunkBytes = options.chunkBytes ?? PAST_GAP_CHUNK_BYTES;
    const clock = options.nowMs ?? Date.now;
    const maxGapLineBytes = options.maxGapLineBytes ?? PAST_GAP_MAX_LINE_BYTES;
    const cache = new Map();
    const unresolvableCache = new Map();
    const own = new Set(isolation.ownRoots.map((root) => nearestExisting(root) ?? root));
    const verdicts = new Map();
    const foreign = (candidate) => {
        const known = verdicts.get(candidate);
        if (known !== undefined)
            return known;
        const root = workTreeRootOf(candidate, cache);
        const verdict = (root !== null && !own.has(root)) || unresolvable(candidate, unresolvableCache);
        verdicts.set(candidate, verdict);
        return verdict;
    };
    const facts = new Map();
    const persistedCodexInfo = (fileKey, id, start) => persistedCallInfo(isolation, fileKey, id, start);
    const needlesOfSpec = new Map();
    const needlesFor = (spec) => {
        let known = needlesOfSpec.get(spec);
        if (known === undefined) {
            known = needlesOf(spec, false);
            needlesOfSpec.set(spec, known);
        }
        return known;
    };
    // C44 (3): ONE multi flag for the whole delivery. `at` is a position in `fileKey`'s stream; another stream is multi from its start.
    let sessionMulti = null;
    const raiseMulti = (fileKey, at) => {
        // C66 (1): the first stream to raise it keeps it, but within that stream the flag only moves EARLIER (a later raise at an earlier position wins).
        if (sessionMulti === null || (sessionMulti.fileKey === fileKey && at < sessionMulti.at))
            sessionMulti = { fileKey, at };
    };
    const codexEnv = (fileKey, position) => {
        const f = facts.get(fileKey);
        const tracker = f?.tracker;
        if (f === undefined || tracker === undefined || position < f.start)
            return persistedCodexEnv(isolation, fileKey, position);
        return {
            turnFolder: () => tracker.turn,
            callFolders: (id) => tracker.callInfo(id)?.paths,
            callFiles: (id) => tracker.callInfo(id)?.files ?? [],
            ownCall: (id) => tracker.callInfo(id),
            session: (id) => lookupIn(tracker.sessions, id, position),
            cell: (id) => lookupIn(tracker.cells, id, position),
            // (No `sessionPlaces`: `observe` steps the tracker BEFORE it judges a call, so the call's own entry already carries the union of the sessions known at it.)
            callsLost: () => callsLostAt(isolation, fileKey, position, f.start),
        };
    };
    const observe = (fileKey, record, offset) => {
        const f = facts.get(fileKey);
        if (f === undefined || offset < f.start)
            return;
        const spec = f.spec;
        // A folder copy has no other work tree to name (a folder target exists only when the session named none): only its calls matter.
        if (sessionMulti === null && isolation.kind !== "folder") {
            // C52 (3): a Codex record's own folder is read by the ONE definition (`ownFoldersOf`: any record type, `file://` decoded), as the scan reads it.
            let sets = (spec.codexFolders === true ? ownFoldersOf(record) : cwdsOfRecord(record, spec.cwdKeys)).some(foreign);
            // A record nested past the walk's depth may name another work tree we cannot see: the resolver counts that as unknown, which is multi (C43).
            const truncated = !sets && walkForPaths(record, spec, (hit) => void (sets = sets || (hit.kind === "path" && foreign(hit.value))), 0);
            if (sets || truncated)
                raiseMulti(fileKey, offset);
        }
        if (spec.codexFolders === true) {
            // Part (b): a Codex stream. The tracker walks the record exactly as the resolver's scan does (turn change, call opened with its folders, output
            // closing and teaching the session and cell maps); a record whose effective folders are inside another work tree raises the session-wide multi flag.
            const stepped = f.tracker?.step(record, offset);
            // C75 (9): an id map collapsed an entry (its byte budget): evidence was lost, so the session is multi from this record (C54 (1)).
            if (stepped?.collapsed === true && sessionMulti === null && isolation.kind !== "folder")
                raiseMulti(fileKey, offset);
            if (sessionMulti === null && isolation.kind !== "folder") {
                const effective = recordFolders(record, codexEnv(fileKey, offset));
                // C53: an UNKNOWN placement still names the folders and files it could read; one in another work tree makes the span multi.
                // A CALL carrying UNJUDGED_FILE (more places than are kept, or one that cannot be resolved) cannot rule another work tree out: the span is multi too (C54 (1)).
                if (("dirs" in effective ? effective.dirs : (effective.evidence ?? [])).some(foreign) || ("unknown" in effective && effective.overflow === true))
                    raiseMulti(fileKey, offset);
            }
        }
        else if (spec.trackCalls === true) {
            const events = { at: offset, opens: [], closes: [], state: { overflow: false } };
            // C44 (7b): EVERY tool call, with empty paths for one that names no file, so a mid-stream observer can answer `none` for it.
            noteCalls(record, spec, events, true);
            for (const open of events.opens)
                if (!f.calls.has(open.id))
                    f.calls.set(open.id, { at: open.at, paths: open.paths, ...(open.incomplete === true ? { incomplete: true } : {}) });
        }
    };
    /** C65 (1): remember the facts as they stand at `at`, where the read about to be observed begins. */
    const snapshotAt = (f, at) => {
        f.snap = { at, ...(f.tracker === undefined ? {} : { tracker: f.tracker.clone() }), calls: new Map(f.calls), unreliable: f.unreliable };
    };
    const failClosed = (f, fileKey, from) => {
        f.unreliable = true;
        // C66 (1): from the earlier of where the unobserved bytes begin (`from` for a read below `coveredTo`, `coveredTo` for a gap before `from`): every byte
        // that was not observed in order is multi, never only the bytes past the old `coveredTo`.
        raiseMulti(fileKey, Math.min(from, f.coveredTo));
        f.coveredTo = from;
    };
    return {
        cursors,
        facts,
        observe,
        multi(fileKey, position) {
            return sessionMulti !== null && (sessionMulti.fileKey !== fileKey || position >= sessionMulti.at);
        },
        codexEnv,
        begin(spec, path, fileKey, from, to) {
            // No facts at all (a test) judges nothing; an unreadable record (`null`) judges every call unknown: neither has an observer to trust.
            if (isolation.calls === undefined || isolation.calls === null)
                return false;
            const cursor = cursors[fileKey] ?? 0;
            // Below this offset the persisted log cannot vouch for a result: a pruned call (the horizon), a stream with no log, an overflowed log.
            const log = isolation.calls[fileKey];
            const horizon = log === undefined || log.overflowed ? cursor : log.horizon;
            const belowHorizon = spec.trackCalls === true && from <= horizon;
            // C51 (1): a stream that already has facts (an earlier chunk of this delivery created the observer) is ALWAYS brought up to `from`, whatever the cursor and
            // the horizon say: `deliver()` skips a record that is too large to send without passing it through `readSpan`, and the bytes it skipped must still be observed.
            let f = facts.get(fileKey);
            if (to <= cursor && !belowHorizon && f === undefined)
                return false;
            if (f === undefined) {
                const start = belowHorizon ? Math.min(from, cursor) : cursor;
                const log = isolation.folders?.[fileKey];
                const tracker = spec.codexFolders === true
                    ? new CodexTracker({
                        turn: lastChangeAtOrBefore(log?.changes, start),
                        // C49 (2): the observer replays from `start`, so it starts with only what was learned BEFORE it (from byte 0: nothing).
                        sessions: idEntriesBefore(log?.sessions, start),
                        cells: idEntriesBefore(log?.cells, start),
                        openCalls: openCallsAt(isolation.calls?.[fileKey], start),
                    }, (id) => persistedCodexInfo(fileKey, id, start), CALL_BOUNDS, (id) => seenCallId(isolation.calls === undefined || isolation.calls === null ? undefined : isolation.calls[fileKey], id, start))
                    : undefined;
                f = { start, spec, coveredTo: start, calls: new Map(), unreliable: false, ...(tracker === undefined ? {} : { tracker }) };
                facts.set(fileKey, f);
            }
            // C65 (1): the observer's position for this read. A read that begins below `start` is judged by the persisted state up to `start`, so the observer begins there.
            const p = Math.max(from, f.start);
            const snap = f.snap;
            if (snap !== undefined && snap.at === p) {
                // The same bytes again (a frame split or a 413 re-reads `[from, to)` from the same `from`; a read that failed half way leaves the tracker ahead of
                // `coveredTo`): the facts go back to what they were when that read began, and the snapshot stays for the next re-read.
                if (snap.tracker !== undefined)
                    f.tracker = snap.tracker.clone();
                f.calls = new Map(snap.calls);
                f.unreliable = snap.unreliable;
                f.coveredTo = p;
                return true;
            }
            if (p < f.coveredTo) {
                // Bytes already observed, read again from a point no snapshot was taken at: nothing can vouch for the state there.
                failClosed(f, fileKey, p);
                return true;
            }
            if (p > f.coveredTo) {
                // The bytes between what was observed and where this read starts (an earlier firing delivered past the cursor, so this span starts beyond it).
                // They are read ONCE here, in order, and fed to the same observer.
                if (p - f.coveredTo > maxGapBytes) {
                    failClosed(f, fileKey, p);
                    snapshotAt(f, p);
                    return true;
                }
                const needles = needlesFor(spec);
                // C44 (6): a line longer than one gap line bound is never parsed (the stream fails closed for the firing), and the deadline is checked before
                // parsing any line over the check size: a parse and walk of one big line cannot be preempted.
                let stop = false;
                // The bounds are BYTES, measured on the accumulated buffer before it is decoded (C45 (3)): a multi-byte line is far longer in bytes than in characters.
                const feed = (raw, at) => {
                    if (raw.length > maxGapLineBytes) {
                        stop = true;
                        return;
                    }
                    if (raw.length > PAST_GAP_CHECK_LINE_BYTES && options.deadlineAtMs !== undefined && clock() + PAST_GAP_CHUNK_COST_MS > options.deadlineAtMs) {
                        stop = true;
                        return;
                    }
                    const line = raw.toString("utf8");
                    // A Codex stream parses EVERY line, as the resolver's scan does: a record that names no folder is placed by the turn folder, so no line can be skipped on its text.
                    if (spec.codexFolders !== true && !needles.some((needle) => line.includes(needle)))
                        return;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
                            observe(fileKey, parsed, at);
                    }
                    catch {
                        // A torn line: nothing to read.
                    }
                };
                let fd;
                try {
                    fd = openSync(path, "r");
                    let position = f.coveredTo;
                    // The bytes of a line that a chunk ended inside, and the offset it began at.
                    let carry = Buffer.alloc(0);
                    let carryAt = position;
                    let expired = false;
                    while (position < from && !stop) {
                        if (options.deadlineAtMs !== undefined && clock() + PAST_GAP_CHUNK_COST_MS > options.deadlineAtMs) {
                            expired = true;
                            break;
                        }
                        const chunk = Buffer.alloc(Math.min(chunkBytes, from - position));
                        const read = readSync(fd, chunk, 0, chunk.length, position);
                        if (read <= 0)
                            throw new Error("short read");
                        const data = carry.length === 0 ? chunk.subarray(0, read) : Buffer.concat([carry, chunk.subarray(0, read)]);
                        position += read;
                        let lineStart = 0;
                        for (let newline = data.indexOf(0x0a, lineStart); newline !== -1 && !stop; newline = data.indexOf(0x0a, lineStart)) {
                            feed(data.subarray(lineStart, newline), carryAt + lineStart);
                            if (!stop)
                                lineStart = newline + 1;
                        }
                        if (stop)
                            break;
                        carry = data.subarray(lineStart);
                        carryAt += lineStart;
                        f.coveredTo = carryAt;
                        // A line still unfinished past the bound is not accumulated further.
                        if (carry.length > maxGapLineBytes)
                            stop = true;
                    }
                    if (expired || stop)
                        failClosed(f, fileKey, from);
                    else {
                        // The span starts on a record boundary, so what is left is one whole last line.
                        if (carry.length > 0)
                            feed(carry, carryAt);
                        if (stop)
                            failClosed(f, fileKey, from);
                        else
                            f.coveredTo = from;
                    }
                }
                catch {
                    failClosed(f, fileKey, from);
                }
                finally {
                    if (fd !== undefined) {
                        try {
                            closeSync(fd);
                        }
                        catch {
                            // Nothing useful to do.
                        }
                    }
                }
            }
            snapshotAt(f, p);
            return true;
        },
        end(fileKey, to) {
            const f = facts.get(fileKey);
            if (f !== undefined && to > f.coveredTo)
                f.coveredTo = to;
        },
    };
}
/** `record`: the session's target record. `undefined`: no facts (legacy callers, tests). `null`: unreadable, so the copy fails closed. */
export function isolationOf(target, record) {
    const base = target.kind === "folder" ? { kind: "folder", ownRoots: [] } : { kind: "repo", ownRoots: target.redactionRoots };
    if (record === undefined)
        return base;
    if (record === null)
        return { ...base, multi: true, calls: null };
    return { ...base, multi: target.multi === true, calls: record.calls, folders: record.folders };
}
/**
 * The redaction scope for one stream (A-T4). Pure `stat` walks, memoised for the span (`workTreeRootOf` caches per directory);
 * no git spawn, so it is free against a hook's budget. A cwd that is gone, or outside every work tree, is NOT another work tree:
 * the record is kept (the structured-path rule still covers a file read from there).
 *
 * `stream` (C40 (1)): the file key of the stream being cut, and whether the dialect tracks calls; with it the scope judges each tool result by the
 * checkpoint's record of its call, by the position the span reports (`at`).
 */
export function redactionScopeFor(isolation, cwdKeys, stream) {
    const cache = new Map();
    const unresolvableCache = new Map();
    let position = 0;
    const past = stream !== undefined ? isolation.past : undefined;
    const spanFacts = () => (stream === undefined ? undefined : past?.facts.get(stream.fileKey));
    // C42: a stream with no persisted log and a cursor of 0 has nothing before the cursor: every call is observed in-span, so the log is a fresh one.
    const logOf = () => {
        if (stream === undefined || isolation.calls === null)
            return undefined;
        const persisted = isolation.calls?.[stream.fileKey];
        return persisted ?? (past !== undefined && (past.cursors[stream.fileKey] ?? 0) === 0 ? FRESH_CALL_LOG : undefined);
    };
    const codex = stream !== undefined && stream.codex === true;
    const callsOf = stream !== undefined && stream.trackCalls && !codex && isolation.calls !== undefined
        ? {
            calls: (rawId) => {
                // C75 (4): the checkpoint keys a call by its BOUNDED id (an id over 128 bytes is its digest); a lookup asks the same way.
                const id = boundedId(rawId);
                const persisted = lookupCall(logOf(), id, position);
                if (typeof persisted !== "string")
                    return persisted;
                const f = spanFacts();
                if (f === undefined)
                    return persisted;
                // A call opened in the bytes this delivery has already passed counts for its later result; only a call in NEITHER place is unknown.
                const seen = f.calls.get(id);
                if (seen !== undefined && seen.at < position)
                    return seen.incomplete === true ? "unknown" : seen.paths.length === 0 ? "none" : seen.paths;
                if (position < f.start)
                    return persisted;
                if (f.unreliable)
                    return "unknown";
                // The observer saw every byte of the stream before this result: a call it did not see named no file (C43).
                return f.start === 0 ? "none" : persisted;
            },
        }
        : {};
    const base = {
        ...(stream !== undefined && (isolation.calls !== undefined || past !== undefined) ? { at: (offset) => void (position = offset) } : {}),
        ...callsOf,
    };
    if (past !== undefined && stream !== undefined)
        base.observe = (record) => past.observe(stream.fileKey, record, position);
    if (isolation.multi !== undefined) {
        const persisted = isolation.multi;
        // C42: from the first record past the cursor that named another work tree, the rest of the span is multi (that record included).
        Object.defineProperty(base, "multi", {
            enumerable: true,
            get: () => {
                if (persisted)
                    return true;
                return stream !== undefined && past !== undefined && past.multi(stream.fileKey, position);
            },
        });
    }
    // C48 (11): the files a Codex record's call names (and its output's call), judged by redact.ts like a Claude path. A record whose folders cannot be told
    // names none here (it is UNKNOWN, decided by the one unknown rule).
    const codexEnvNow = () => (past !== undefined && stream !== undefined ? past.codexEnv(stream.fileKey, position) : persistedCodexEnv(isolation, stream?.fileKey ?? "", position));
    const namedFiles = codex && stream !== undefined
        ? {
            namedFiles: (record) => {
                const f = spanFacts();
                // A repo copy withholds such a record through `foreignRecord` (the span is multi from where the facts were lost). A folder copy has no multi flag, so the record
                // itself carries the mark that withholds it from every copy (C66 (1)).
                if (f !== undefined && f.unreliable && position >= f.start)
                    return isolation.kind === "folder" ? [UNJUDGED_FILE] : [];
                const effective = recordFolders(record, codexEnvNow());
                // A file the turn deleted or moved is judged by its nearest existing ancestor (the Claude rule's `isInside` calls a missing path "outside").
                // C52 (1): an UNKNOWN placement still carries the files the record names.
                return [...(effective.files ?? []), ...(effective.inputFiles ?? [])].map((file) => (file === UNJUDGED_FILE ? file : (nearestExisting(file) ?? file)));
            },
        }
        : {};
    if (isolation.kind === "folder") {
        return Object.defineProperties({ hole: (candidate) => workTreeRootOf(candidate, cache) !== null, ...namedFiles }, Object.getOwnPropertyDescriptors(base));
    }
    const own = new Set(isolation.ownRoots.map((root) => nearestExisting(root) ?? root));
    const verdicts = new Map();
    const foreign = (cwd) => {
        const known = verdicts.get(cwd);
        if (known !== undefined)
            return known;
        const root = workTreeRootOf(cwd, cache);
        const verdict = root !== null && !own.has(root);
        verdicts.set(cwd, verdict);
        return verdict;
    };
    if (codex && stream !== undefined) {
        // Part (b): Codex records name a folder on few types; every record's folder is its EFFECTIVE folder (its own cwd, its call's workdir or patched files,
        // its call's folder for an output, else the turn folder in force). A record that cannot be placed is UNKNOWN: withheld in a multi-repo copy, kept in a
        // single-repo one. A record whose folders span two work trees (a patch across two repos) is withheld from both copies.
        const fileKey = stream.fileKey;
        const multiNow = () => isolation.multi === true || (past !== undefined && past.multi(fileKey, position));
        const foreignRecord = (record) => {
            const f = spanFacts();
            if (f !== undefined && f.unreliable && position >= f.start)
                return multiNow();
            const effective = recordFolders(record, past !== undefined ? past.codexEnv(fileKey, position) : persistedCodexEnv(isolation, fileKey, position));
            if (!("dirs" in effective))
                return multiNow();
            const roots = new Set();
            for (const dir of effective.dirs) {
                // C50 (3): a place that exists but cannot be resolved is not "no work tree": the record is UNKNOWN.
                if (unresolvable(dir, unresolvableCache))
                    return multiNow();
                const root = workTreeRootOf(dir, cache);
                if (root !== null)
                    roots.add(root);
            }
            if (roots.size === 0)
                return false;
            if (roots.size > 1)
                return true;
            return !own.has([...roots][0]);
        };
        return Object.defineProperties({ foreignRecord, ...namedFiles }, Object.getOwnPropertyDescriptors(base));
    }
    return Object.defineProperties({ foreignRecord: (record) => cwdsOfRecord(record, cwdKeys).some(foreign) }, Object.getOwnPropertyDescriptors(base));
}
function sessionFiles(home, sessionId) {
    const sessions = sessionsRoot(home);
    const stem = sessionFileStem(sessionId);
    const spoolSuffixes = [".spool.jsonl", ".pending.jsonl", ".rewrites.jsonl", ".inferred.jsonl"];
    let digests;
    try {
        digests = readdirSync(sessions);
    }
    catch (error) {
        return { listFailed: error.code !== "ENOENT", spoolKeys: [], ledgerKeys: [], unmappedSpool: false, ledgerDigests: [] };
    }
    const noted = (digest) => {
        try {
            const key = readFileSync(join(targetsDir(home), `${digest}.repo`), "utf8").trim();
            const path = key.startsWith(FOLDER_LEDGER_PREFIX) ? key.slice(FOLDER_LEDGER_PREFIX.length) : key;
            return isAbsolute(path) && repoKeyDigest(key) === digest ? key : null;
        }
        catch {
            return null;
        }
    };
    const spoolKeys = [];
    const ledgerKeys = [];
    const ledgerDigests = [];
    let unmappedSpool = false;
    for (const digest of digests) {
        const hasSpool = spoolSuffixes.some((suffix) => existsSync(join(sessions, digest, `${stem}${suffix}`)));
        const hasLedger = existsSync(join(sessions, digest, `${stem}.json`));
        if (!hasSpool && !hasLedger)
            continue;
        const key = noted(digest);
        // A folder ledger is a ledger (its digest is counted, so it is never "unaccounted" by accident) but it is not a work tree: it
        // is never a candidate root.
        const isFolder = key !== null && key.startsWith(FOLDER_LEDGER_PREFIX);
        if (hasLedger) {
            ledgerDigests.push(digest);
            if (key !== null && !isFolder)
                ledgerKeys.push(key);
        }
        if (hasSpool) {
            if (key === null)
                unmappedSpool = true;
            else if (!isFolder)
                spoolKeys.push(key);
        }
    }
    return { listFailed: false, spoolKeys, ledgerKeys, unmappedSpool, ledgerDigests };
}
function defaultSpawnOk() {
    return spawnTimeoutMs(MIN_SPAWN_TIMEOUT_MS) !== null;
}
/**
 * Name one candidate root: its keys, slug and redaction roots, or `deferred` (null) when the spawn window ran out.
 *
 * ⛔ **A REFUSED SPAWN IS NEVER A FALLBACK IDENTITY** (R16 · D18). `resolveProjectKeys` returns null both for "not a work
 * tree" and for "no budget left", and `resolveRepoSlug` falls back to `local:<hash of this path>` when its remote lookup is
 * refused. Both are indistinguishable from their real answers by value, so the window is checked before AND after, and a
 * result that could have been a refusal is dropped for next firing instead of stored.
 */
function nameRoot(dir, ctx) {
    const spawnOk = ctx.seams?.spawnOk ?? defaultSpawnOk;
    const known = ctx.known !== undefined && (dir === ctx.known.keys.worktree || realOrNull(ctx.known.keys.worktree) === dir) ? ctx.known : null;
    if (known === null && !spawnOk())
        return null;
    const keys = known !== null ? known.keys : (ctx.seams?.resolveKeys ?? resolveProjectKeys)(dir);
    // After EVERY spawn step: a window that died during it may have turned a real answer into null (or a missing second
    // redaction root), and none of those is distinguishable by value. One check covers all.
    if (!spawnOk())
        return null;
    // A directory holding `.git` that git will not name: NOT "no repo" (P2 F1). The caller retries it a bounded number of times.
    if (keys === null)
        return "unnamed";
    // `null` is git failing or timing out (`strictRepoSlug`), never an absent remote: defer rather than store `local:<path hash>`.
    const slug = known !== null ? known.slugOf() : (ctx.seams?.slugOf ?? strictRepoSlug)(keys.worktree);
    // The window dying DURING the lookup is a deferral that costs nothing; git failing with budget to spare is a FAILURE (C17 #11): it is
    // counted, so roots that can never be named stop holding the per-firing slots, and the failed ones go to the back of the queue.
    if (!spawnOk())
        return null;
    if (slug === null)
        return "unnamed";
    const roots = (ctx.seams?.rootsOf ?? confinementRoots)(keys);
    if (!spawnOk())
        return null;
    return { state: "repo", toplevel: keys.worktree, commonDir: keys.consent, slug, roots: [...roots] };
}
/**
 * What makes two work trees ONE repository for a target (R5). A remote repo is its normalised slug. A repo with NO remote has a
 * `local:<hash of its path>` slug that differs per work tree, yet its work trees share one git common dir and are one
 * repository; grouping by slug alone would split a main clone and its worktrees into two targets and send a session twice.
 * The slug SENT is the preferred member's (the turn-end work tree first), exactly as 0.8.0 sent the turn-end tree's.
 */
export function groupKey(info) {
    return info.slug.startsWith("local:") ? `common:${info.commonDir}` : normalizeSlug(info.slug);
}
function ledgerExists(home, ledgerKey, sessionId) {
    const path = sessionStatePath(home, { repoKey: ledgerKey, sessionId });
    return path !== null && existsSync(path);
}
/**
 * R5 · O6: which worktree's ledger a (slug, session) uses. An existing ledger beats a new one (nothing re-sends at upgrade);
 * among several, the latest successful send ACROSS EVERY STREAM (main and each sub-agent's `lastSentAt`), then `seq`, is adopted
 * and the rest are set aside; with none, the first worktree seen. `candidates` arrive in first-seen order, turn-end first.
 *
 * "Set aside" means the other ledgers' offsets and seq NEVER reach the target and are never merged: they are loaded only to
 * RANK, which is the one read the rule needs.
 */
function chooseLedger(home, sessionId, candidates) {
    const holding = candidates.filter((worktree) => ledgerExists(home, worktree, sessionId));
    if (holding.length === 0)
        return { ledgerKey: candidates[0], setAside: [], adopted: false };
    let best = holding[0];
    let bestRank = [-1, -1];
    for (const worktree of holding) {
        const state = loadSessionState(home, { repoKey: worktree, sessionId });
        const lastSent = Math.max(0, ...Object.values(state.files).map((file) => file.lastSentAt));
        const rank = [lastSent, state.seq];
        if (rank[0] > bestRank[0] || (rank[0] === bestRank[0] && rank[1] > bestRank[1])) {
            best = worktree;
            bestRank = rank;
        }
    }
    return { ledgerKey: best, setAside: holding.filter((worktree) => worktree !== best), adopted: true };
}
/** A stream scanned from its first byte: nothing is unknown yet. */
const FRESH_CALL_LOG = { entries: [], horizon: 0, overflowed: false };
/**
 * C56 (1) / C57 G4: the ids of entries that LEFT the table (evicted for the cap, dropped for the closed cap, or pruned once every copy had passed them) and carried
 * names. Bounded at MAX_DROPPED_IDS; past the bound every output whose call is not an entry is unjudged (sticky). C62: a Set (insertion order, O(1) per drop), so a
 * firing that drops many entries never re-scans the list.
 */
class NamedDrops {
    ids;
    all;
    constructor(ids, all) {
        this.ids = new Set(ids ?? []);
        this.all = all === true;
    }
    /** Remember the entry's id when it carried names. Returns what changed: undefined when it carried none, else the id that fell off the end (if any). */
    note(entry) {
        if (entry.named !== true && (entry.files?.length ?? 0) === 0)
            return undefined;
        this.ids.delete(entry.id);
        this.ids.add(entry.id);
        if (this.ids.size > MAX_DROPPED_IDS) {
            const evicted = this.ids.values().next().value;
            this.ids.delete(evicted);
            this.all = true;
            return { evicted };
        }
        return {};
    }
    /** The fields of a `CallLog` for this state. */
    fields() {
        return { ...(this.ids.size > 0 ? { droppedNamed: [...this.ids] } : {}), ...(this.all ? { droppedNamedAll: true } : {}) };
    }
}
/** C62 (4): remember that `id` LEFT a call table (closed-cap drop or prune). Bounded at MAX_DROPPED_IDS, the oldest is forgotten, not sticky. */
function noteDeparted(departed, id) {
    departed.delete(id);
    departed.add(id);
    if (departed.size > MAX_DROPPED_IDS) {
        const forgotten = departed.values().next().value;
        departed.delete(forgotten);
        return forgotten;
    }
    return undefined;
}
/**
 * C75 (8) / C76: evict the OLDEST entries that store path text from a call log until `free` bytes are freed (or none is left), through the marks the count caps use: an open entry is
 * remembered in `droppedIds` (its result is unknown), a closed one raises the horizon and leaves a departed id, and each leaves its `named` mark, so its output fails closed.
 * `measure` "text" counts the path text an entry stores (the table's own budget); "full" counts the whole entry as the session budget does, NET of the ids that join lists (an evicted
 * id joins one list, two when it is named), and the result carries the EXACT bytes freed. `keepNewest` entries at the end are left alone.
 */
function shedCallsExact(log, free, includePathless, measure, keepNewest) {
    let entries = log.entries;
    let horizon = log.horizon;
    let overflowed = log.overflowed;
    const droppedIds = [...(log.droppedIds ?? [])];
    let droppedFrom = 0;
    const named = new NamedDrops(log.droppedNamed, log.droppedNamedAll);
    const departed = new Set(log.prunedIds ?? []);
    const evict = new Set();
    let freed = 0;
    const limit = Math.max(0, entries.length - keepNewest);
    for (let at = 0; at < limit; at += 1) {
        const entry = entries[at];
        if (freed >= free)
            break;
        // (The table's own budget leaves an entry that stores no path text alone: its output's fate is already "unknown", and its fixed cost is bounded by the entry-count caps. The SESSION
        // budget counts everything a stream stores and sheds those too: `includePathless`.)
        if (pathBytes(entry) === 0 && !includePathless)
            continue;
        evict.add(entry.id);
        freed += measure === "text" ? pathBytes(entry) : callEntryBytes(entry);
        const item = listItemBytes(entry.id);
        if (entry.closedAt === null) {
            droppedIds.push(entry.id);
            if (measure === "full")
                freed -= item;
            // A list at its cap forgets its oldest id for each one it takes: the forgotten id's bytes are credited at once, so the loop stops when the excess is met.
            if (droppedIds.length - droppedFrom > MAX_DROPPED_IDS) {
                if (measure === "full")
                    freed += listItemBytes(droppedIds[droppedFrom]);
                droppedFrom += 1;
                overflowed = true;
                named.all = true;
            }
        }
        else {
            horizon = Math.max(horizon, entry.closedAt);
            const forgotten = noteDeparted(departed, entry.id);
            if (measure === "full")
                freed -= item - (forgotten === undefined ? 0 : listItemBytes(forgotten));
        }
        const joined = named.note(entry);
        if (measure === "full" && joined !== undefined)
            freed -= item - (joined.evicted === undefined ? 0 : listItemBytes(joined.evicted));
    }
    if (evict.size === 0 && droppedIds.length - droppedFrom <= MAX_DROPPED_IDS)
        return { log, freed: 0 };
    if (evict.size > 0)
        entries = entries.filter((entry) => !evict.has(entry.id));
    // (An incoming list longer than its cap, which the fold never leaves, is cut too.)
    if (droppedIds.length - droppedFrom > MAX_DROPPED_IDS) {
        const cut = droppedIds.length - droppedFrom - MAX_DROPPED_IDS;
        if (measure === "full")
            for (let i = 0; i < cut; i += 1)
                freed += listItemBytes(droppedIds[droppedFrom + i]);
        droppedFrom += cut;
        overflowed = true;
        named.all = true;
    }
    const ids = droppedFrom > 0 ? droppedIds.slice(droppedFrom) : droppedIds;
    return { log: { entries, horizon, overflowed, ...(ids.length > 0 ? { droppedIds: ids } : {}), ...named.fields(), ...(departed.size > 0 ? { prunedIds: [...departed] } : {}) }, freed };
}
/** The log with its oldest path-bearing entries evicted until `free` bytes of path TEXT are freed (the table's own budget). */
export function shedCalls(log, free, includePathless = false, measure = "full", keepNewest = 0) {
    return shedCallsExact(log, free, includePathless, measure, keepNewest).log;
}
/**
 * C76 (3): ONE budget for a whole SESSION. Every stream (the main transcript and each subagent's) has its own tables, each held to its own bound, and a session can have any number of
 * streams. After a firing has folded its events, the bytes the session's streams store (call entries, the three id lists, the Codex id maps and the folder timeline) may not pass
 * `SESSION_BUDGET_BYTES`. C77: they are counted by an UPPER bound of their JSON size (the fixed cost of an entry, the escaped length of every string), so the record on disk is within the
 * budget, not near it.
 */
export const SESSION_BUDGET_BYTES = 6 * 1024 * 1024;
/** The newest call entries of a stream that the session budget sheds only after everything else (see `shedSession`). */
const RECENT_CALLS = 64;
/** C78: what a stream's envelope takes in the record beyond its tables: its keys under calls, folders and scan, and their fixed fields (a cursor, a horizon, flags). */
const STREAM_ENVELOPE_BYTES = 512;
/** The fewest bytes one shedding pass takes from a stream (keeps the passes few when many streams are near equal). */
const MIN_SHED_CHUNK = 64 * 1024;
// C77 (4): the session budget counts UPPER bounds of the persisted JSON: the escaped length of each string, plus a fixed cost per entry that covers its field names and the longest offsets.
const CALL_FIXED_BYTES = 160;
const MAP_FIXED_BYTES = 160;
const DIR_FIXED_BYTES = 64;
const POINT_FIXED_BYTES = 64;
/** The bytes of a string as a JSON literal in the record (quotes and escapes included, UTF-8). */
const jsonBytes = (text) => Buffer.byteLength(JSON.stringify(text), "utf8");
/** One string in a JSON list: its literal and the comma. */
const listItemBytes = (text) => jsonBytes(text) + 1;
const listBytes = (items) => {
    let total = 0;
    for (const item of items ?? [])
        total += listItemBytes(item);
    return total;
};
/** What a call entry takes in the record (an upper bound). */
export function callEntryBytes(entry) {
    return CALL_FIXED_BYTES + jsonBytes(entry.id) + (entry.tool === undefined ? 0 : jsonBytes(entry.tool)) + listBytes(entry.paths) + listBytes(entry.files);
}
/** What an id-map entry takes in the record (an upper bound). */
function mapEntryBytes(key, entry) {
    let total = MAP_FIXED_BYTES + jsonBytes(key);
    for (const learned of entry.dirs)
        total += jsonBytes(learned.dir) + DIR_FIXED_BYTES;
    return total + listBytes(entry.files) + listBytes(entry.evidence);
}
const pointBytes = (change) => POINT_FIXED_BYTES + (change.dir === null ? 0 : jsonBytes(change.dir));
/** What one stream's tables take in the record (an upper bound), measured once per firing. */
function streamBytes(log, folders) {
    let total = 0;
    for (const entry of log?.entries ?? [])
        total += callEntryBytes(entry);
    total += listBytes(log?.droppedIds) + listBytes(log?.droppedNamed) + listBytes(log?.prunedIds);
    for (const [key, entry] of folders?.sessions ?? [])
        total += mapEntryBytes(key, entry);
    for (const [key, entry] of folders?.cells ?? [])
        total += mapEntryBytes(key, entry);
    for (const change of folders?.changes ?? [])
        total += pointBytes(change);
    return total;
}
/** What a whole session's records take by the same measure. Exported for the cells. */
export function sessionBytes(calls, folders) {
    let total = 0;
    for (const key of new Set([...Object.keys(calls), ...Object.keys(folders)]))
        total += STREAM_ENVELOPE_BYTES + streamBytes(calls[key], folders[key]);
    return total;
}
/** A max-heap of (size, key) with lazy deletion: an item is valid while the stream still has that size. */
class SizeHeap {
    items = [];
    push(size, key) {
        this.items.push([size, key]);
        let at = this.items.length - 1;
        while (at > 0) {
            const parent = (at - 1) >> 1;
            if (this.items[parent][0] >= this.items[at][0])
                break;
            [this.items[parent], this.items[at]] = [this.items[at], this.items[parent]];
            at = parent;
        }
    }
    pop() {
        const top = this.items[0];
        const last = this.items.pop();
        if (top === undefined || last === undefined)
            return undefined;
        if (this.items.length > 0) {
            this.items[0] = last;
            let at = 0;
            for (;;) {
                const left = 2 * at + 1;
                const right = left + 1;
                let largest = at;
                if (left < this.items.length && this.items[left][0] > this.items[largest][0])
                    largest = left;
                if (right < this.items.length && this.items[right][0] > this.items[largest][0])
                    largest = right;
                if (largest === at)
                    break;
                [this.items[largest], this.items[at]] = [this.items[at], this.items[largest]];
                at = largest;
            }
        }
        return top;
    }
    /** The largest valid stream, removed; and the size of the next valid one (0 if none). */
    takeTop(valid) {
        for (;;) {
            const top = this.pop();
            if (top === undefined)
                return undefined;
            if (!valid(top[0], top[1]))
                continue;
            while (this.items.length > 0 && !valid(this.items[0][0], this.items[0][1]))
                this.pop();
            return { size: top[0], key: top[1], next: this.items.length > 0 ? this.items[0][0] : 0 };
        }
    }
}
const NOTHING = { freed: 0, changed: false };
/**
 * Shed the session down to `budget`, in place on the two records. Returns true when a Codex id map lost evidence. The stream that holds the most sheds (a heap gives it in O(log streams)),
 * down to the next largest, or its share of the excess when several tie, never more than the excess; so no stream is emptied while another keeps its oldest calls. Two phases:
 *  A. each pass takes at least `MIN_SHED_CHUNK` and runs, stopping as soon as its chunk is freed, (i) the stream's call entries STRICTLY OLDEST FIRST by position, with or without path
 *     text, each with its departure marks, except its `RECENT_CALLS` newest (a result arrives right after its call: without that floor, a stream whose id lists alone fill its share would
 *     lose its newest calls too); (ii) the oldest ids of its id lists, prunedIds first (not sticky), then droppedNamed, then droppedIds, each list's sticky mark set ONLY when it lost ids;
 *     (iii) the oldest Codex id-map tombstones (the whole map reads UNKNOWN from there); (iv) the oldest text of its id maps (collapse); (v) the oldest timeline points.
 *  B. only when NO stream has anything older left to shed, (vi) the newest call entries, by plain water-filling with no floor: a stream never loses the calls it was just scanned for
 *     while another still keeps older content.
 * Every step returns the exact bytes it freed and the sizes are kept by subtraction, a growth (an eviction that adds a mark) booked as a negative amount; a stream is left out only when no
 * step changed anything. A firing costs O(streams + evictions), plus one measure of every stream.
 */
export function shedSession(calls, folders, budget = SESSION_BUDGET_BYTES) {
    const keys = [...new Set([...Object.keys(calls), ...Object.keys(folders)])];
    const sizes = new Map();
    let total = 0;
    for (const key of keys) {
        const size = STREAM_ENVELOPE_BYTES + streamBytes(calls[key], folders[key]);
        sizes.set(key, size);
        total += size;
    }
    if (total <= budget)
        return false;
    let collapsed = false;
    const asShed = (before, after, freed) => ({ freed, changed: before !== after || freed !== 0 });
    const older = [
        (key, free) => shedCallLog(calls, key, free, RECENT_CALLS),
        (key, free) => {
            let freed = 0;
            let changed = false;
            for (const field of ["prunedIds", "droppedNamed", "droppedIds"]) {
                const log = calls[key];
                if (log === undefined || freed >= free)
                    break;
                const shed = shedList(log, field, free - freed);
                calls[key] = shed.log;
                freed += shed.freed;
                changed ||= shed.log !== log;
            }
            return { freed, changed };
        },
        (key, free) => {
            let freed = 0;
            let changed = false;
            for (const kind of ["sessions", "cells"]) {
                const folder = folders[key];
                if (folder === undefined || freed >= free)
                    break;
                const shed = shedTombs(folder[kind], free - freed);
                if (shed.lost)
                    collapsed = true;
                if (shed.lost)
                    folders[key] = { ...folder, [kind]: shed.entries };
                freed += shed.freed;
                changed ||= shed.lost;
            }
            return { freed, changed };
        },
        (key, free) => {
            let freed = 0;
            let changed = false;
            for (const kind of ["sessions", "cells"]) {
                const folder = folders[key];
                if (folder === undefined || freed >= free)
                    break;
                const shed = shedIdMap(folder[kind], free - freed);
                if (shed.collapsed)
                    collapsed = true;
                if (shed.collapsed)
                    folders[key] = { ...folder, [kind]: shed.entries };
                freed += shed.freed;
                changed ||= shed.collapsed;
            }
            return { freed, changed };
        },
        (key, free) => {
            const folder = folders[key];
            if (folder === undefined)
                return NOTHING;
            const shed = shedTimeline(folder.changes, free);
            if (shed.changes === folder.changes)
                return NOTHING;
            folders[key] = { ...folder, changes: shed.changes };
            return asShed(folder.changes, shed.changes, shed.freed);
        },
    ];
    // Last of all: the newest call entries too.
    const newest = [(key, free) => shedCallLog(calls, key, free, 0)];
    const phase = (list, floor) => {
        const heap = new SizeHeap();
        const exhausted = new Set();
        for (const key of keys)
            heap.push(sizes.get(key), key);
        let live = keys.length;
        const valid = (size, key) => !exhausted.has(key) && sizes.get(key) === size;
        while (total > budget) {
            const top = heap.takeTop(valid);
            if (top === undefined)
                return;
            const over = total - budget;
            const target = Math.min(over, Math.max(top.size - top.next, Math.ceil(over / Math.max(1, live)), floor));
            let freed = 0;
            let changed = false;
            for (const step of list) {
                if (freed >= target)
                    break;
                const result = step(top.key, target - freed);
                freed += result.freed;
                changed ||= result.changed;
            }
            if (!changed) {
                exhausted.add(top.key);
                live -= 1;
                continue;
            }
            // (A pass that grew the record, an eviction whose mark outweighs it, is booked as the negative it is.)
            total -= freed;
            sizes.set(top.key, top.size - freed);
            heap.push(top.size - freed, top.key);
        }
    };
    phase(older, MIN_SHED_CHUNK);
    if (total > budget)
        phase(newest, 0);
    return collapsed;
}
function shedCallLog(calls, key, free, keepNewest) {
    const log = calls[key];
    if (log === undefined)
        return NOTHING;
    const shed = shedCallsExact(log, free, true, "full", keepNewest);
    if (shed.log === log)
        return NOTHING;
    calls[key] = shed.log;
    return { freed: shed.freed, changed: true };
}
/** Drop the OLDEST ids of one id list until `free` bytes are freed. The list's sticky mark is set ONLY when it actually lost ids (a list that lost nothing has not lost anything to remember). */
function shedList(log, field, free) {
    const ids = log[field] ?? [];
    let cut = 0;
    let freed = 0;
    while (cut < ids.length && freed < free) {
        freed += listItemBytes(ids[cut]);
        cut += 1;
    }
    if (cut === 0)
        return { log, freed: 0 };
    const kept = ids.slice(cut);
    const { [field]: _gone, ...rest } = log;
    void _gone;
    const next = { ...rest, ...(kept.length > 0 ? { [field]: kept } : {}) };
    // A forgotten dropped id may have been an unmatched result that is now read as "named nothing": the log is overflowed (every unmatched result is unknown) and no forgotten id is trusted
    // not to have carried files. A forgotten named id turns on the "whole map unjudged" mark. A forgotten pruned id only loses its repeat check (the list is not sticky).
    if (field === "droppedIds")
        return { log: { ...next, overflowed: true, droppedNamedAll: true }, freed };
    if (field === "droppedNamed")
        return { log: { ...next, droppedNamedAll: true }, freed };
    return { log: next, freed };
}
/** Forget the OLDEST tombstones of a persisted id map until `free` bytes are freed NET of the mark that comes with it; the map then reads UNKNOWN from the start (`ALL_UNKNOWN`), which is evidence lost. */
function shedTombs(entries, free) {
    const map = new IdMap(entries ?? []);
    const had = map.has(ALL_UNKNOWN);
    // The mark is added once, with the first tombstone forgotten: it is part of what must be won back.
    const markCost = had ? 0 : mapEntryBytes(ALL_UNKNOWN, { dirs: [], unknownAt: 0 });
    let freed = 0;
    let lost = false;
    while (freed < free + markCost) {
        const forgotten = map.evictOldestTomb(0);
        if (forgotten === undefined)
            break;
        freed += mapEntryBytes(forgotten[0], forgotten[1]);
        lost = true;
    }
    if (lost)
        freed -= markCost;
    return { entries: boundedIdEntries(lost ? [...map] : (entries ?? [])), lost, freed };
}
/** Collapse the OLDEST text-bearing entries of a persisted id map until `free` bytes are freed. */
function shedIdMap(entries, free) {
    const map = new IdMap(entries ?? []);
    let freed = 0;
    for (;;) {
        if (freed >= free)
            break;
        const key = map.oldestText();
        if (key === undefined)
            break;
        const before = map.get(key);
        map.collapse(key, 0);
        freed += mapEntryBytes(key, before) - mapEntryBytes(key, map.get(key));
    }
    return { entries: boundedIdEntries([...map]), collapsed: map.takeCollapsed(), freed };
}
/** Drop the OLDEST change points of a timeline until `free` bytes are freed (a position before the first kept point is unknown). */
function shedTimeline(changes, free) {
    let cut = 0;
    let freed = 0;
    while (cut < changes.length - 1 && freed < free) {
        freed += pointBytes(changes[cut]);
        cut += 1;
    }
    return { changes: cut === 0 ? changes : changes.slice(cut), freed };
}
/** The path text an entry stores (what the budget can free by evicting it). */
function pathBytes(entry) {
    return storedBytes(entry.paths) + storedBytes(entry.files ?? []);
}
/**
 * C40 (1): fold the calls one scan read into a stream's checkpoint. Opens first, then closes (a result always follows its call in the file). More than
 * `MAX_OPEN_CALLS` waiting drops the oldest and marks the log overflowed; more than `MAX_CLOSED_CALLS` closed drops the oldest and raises the horizon.
 * `unread` (an oversize line, an input too deep to read) marks the log overflowed: a call may have been missed.
 */
export function applyCallEvents(log, events, unread) {
    const entries = [...log.entries];
    const index = new Map(entries.map((entry, at) => [entry.id, at]));
    const droppedSeen = new Set([...(log.droppedIds ?? []), ...(log.droppedNamed ?? []), ...(log.prunedIds ?? [])]);
    for (const open of events.opens) {
        const prior = index.get(open.id);
        if (prior !== undefined) {
            // C62 (3): a Codex call that opens an id already in the table poisons it (the entry is reopened); a Claude call keeps the first, as before.
            if (open.tool !== undefined)
                entries[prior] = { ...poisonRepeated(entries[prior]), closedAt: null };
            continue;
        }
        index.set(open.id, entries.length);
        const entry = {
            id: open.id,
            at: open.at,
            paths: open.paths,
            closedAt: null,
            ...(open.incomplete === true ? { incomplete: true } : {}),
            ...(open.tool === undefined ? {} : { tool: open.tool }),
            ...(open.files === undefined ? {} : { files: open.files }),
            ...(open.named === true ? { named: true } : {}),
        };
        // An id the checkpoint dropped earlier is known too.
        const kept1 = open.tool !== undefined && droppedSeen.has(open.id) ? poisonRepeated(entry) : entry;
        // C75 (8): an entry whose own stored places pass the budget is never stored: it is UNKNOWN (Codex: UNJUDGED_FILE; Claude: INCOMPLETE). (`placeCall` and `noteCalls` already refuse it; this is the table's own guard.)
        entries.push(pathBytes(kept1) > CALL_LOG_BUDGET_BYTES ? (kept1.tool !== undefined ? { ...poisonRepeated({ ...kept1, files: [] }), paths: [] } : { ...kept1, paths: [], incomplete: true }) : kept1);
    }
    for (const close of events.closes) {
        const at = index.get(close.id);
        if (at === undefined)
            continue;
        const entry = entries[at];
        if (entry.closedAt === null)
            entries[at] = { ...entry, closedAt: close.at };
    }
    let overflowed = log.overflowed || unread || events.overflow;
    let horizon = log.horizon;
    let kept = entries;
    let droppedIds = log.droppedIds ?? [];
    const named = new NamedDrops(log.droppedNamed, log.droppedNamedAll);
    const departed = new Set(log.prunedIds ?? []);
    const noteNamed = (entry) => void named.note(entry);
    const open = kept.filter((entry) => entry.closedAt === null);
    if (open.length > MAX_OPEN_CALLS) {
        // C44 (7a): the dropped ids are remembered (bounded) so ONLY their results are unknown; the log stays usable for every other id.
        const dropping = open.slice(0, open.length - MAX_OPEN_CALLS);
        const drop = new Set(dropping.map((entry) => entry.id));
        kept = kept.filter((entry) => !drop.has(entry.id));
        droppedIds = [...droppedIds, ...dropping.map((entry) => entry.id)];
        for (const entry of dropping)
            noteNamed(entry);
        if (droppedIds.length > MAX_DROPPED_IDS) {
            droppedIds = droppedIds.slice(droppedIds.length - MAX_DROPPED_IDS);
            overflowed = true;
            // C56 (11): the forgotten ids may have carried files: from here every output whose call is not an entry is unjudged.
            named.all = true;
        }
    }
    // C75 (8): the TABLE's byte budget. What the entries store (paths and files, open and closed) may not pass CALL_LOG_BUDGET_BYTES per stream: the oldest entries that store anything
    // are evicted until it fits (`shedCalls`: the same marks as the count caps).
    // C76: it compares only the path TEXT the entries store (what an eviction can free); the fixed cost of an entry (id, tool, offsets) is bounded by the count caps, and the SESSION budget counts it.
    let stored = 0;
    for (const entry of kept)
        stored += pathBytes(entry);
    if (stored > CALL_LOG_BUDGET_BYTES) {
        const shed = shedCalls({ entries: kept, horizon, overflowed, ...(droppedIds.length > 0 ? { droppedIds } : {}), ...named.fields(), ...(departed.size > 0 ? { prunedIds: [...departed] } : {}) }, stored - CALL_LOG_BUDGET_BYTES, false, "text");
        kept = [...shed.entries];
        horizon = shed.horizon;
        overflowed = shed.overflowed;
        droppedIds = shed.droppedIds ?? [];
        named.ids.clear();
        for (const id of shed.droppedNamed ?? [])
            named.ids.add(id);
        named.all = shed.droppedNamedAll === true;
        departed.clear();
        for (const id of shed.prunedIds ?? [])
            departed.add(id);
    }
    const closed = kept.filter((entry) => entry.closedAt !== null).sort((a, b) => a.closedAt - b.closedAt);
    if (closed.length > MAX_CLOSED_CALLS) {
        const dropped = closed.slice(0, closed.length - MAX_CLOSED_CALLS);
        const drop = new Set(dropped.map((entry) => entry.id));
        horizon = Math.max(horizon, ...dropped.map((entry) => entry.closedAt));
        kept = kept.filter((entry) => !drop.has(entry.id));
        for (const entry of dropped) {
            noteNamed(entry);
            noteDeparted(departed, entry.id);
        }
    }
    return {
        entries: kept,
        horizon,
        overflowed,
        ...(droppedIds.length > 0 ? { droppedIds } : {}),
        ...named.fields(),
        ...(departed.size > 0 ? { prunedIds: [...departed] } : {}),
    };
}
/**
 * C40 (1): remove the entries whose result EVERY copy is already past (`lowWater` is the smallest sent offset of the stream over the session's
 * targets): the paths are gone as soon as nobody can need them. A later copy that still needs one (a target created late starts at offset 0) finds
 * the horizon raised and reads the call as unknown: withheld, never kept.
 */
export function pruneCalls(log, lowWater) {
    let horizon = log.horizon;
    const kept = [];
    const named = new NamedDrops(log.droppedNamed, log.droppedNamedAll);
    const pruned = new Set(log.prunedIds ?? []);
    for (const entry of log.entries) {
        if (entry.closedAt !== null && entry.closedAt < lowWater) {
            // C62 (4): every pruned id is remembered (bounded, the oldest forgotten): a later reuse is a REPEATED id even when the pruned call named nothing.
            noteDeparted(pruned, entry.id);
            horizon = Math.max(horizon, entry.closedAt);
            // C57 G4: a pruned entry that carried names is remembered like an evicted one: a later output with its id (above the horizon) is unjudged.
            named.note(entry);
            continue;
        }
        kept.push(entry);
    }
    return kept.length === log.entries.length && horizon === log.horizon
        ? log
        : {
            entries: kept,
            horizon,
            overflowed: log.overflowed,
            ...(log.droppedIds === undefined ? {} : { droppedIds: log.droppedIds }),
            ...named.fields(),
            ...(pruned.size > 0 ? { prunedIds: [...pruned] } : {}),
        };
}
/**
 * C40 (1): what the checkpoint says about the result of call `id` found at byte `at` of its stream. The entry's paths (judged per copy by the
 * caller), `none` (the call named no file: kept, a stated residual), or `unknown` (withheld, failing closed).
 */
export function lookupCall(log, id, at) {
    if (log === undefined)
        return "unknown";
    const entry = log.entries.find((candidate) => candidate.id === id);
    if (entry !== undefined)
        return entry.incomplete === true ? "unknown" : entry.paths;
    if (log.droppedIds?.includes(id) === true)
        return "unknown";
    return log.overflowed || at <= log.horizon ? "unknown" : "none";
}
/**
 * Turn a session's evidence into targets. ⛔ **The caller holds the one per-session lock** (O5); this reads the record,
 * scans new bytes, resolves a bounded number of new roots, and saves the record.
 *
 * Evidence (R2 · D2 · A): the turn-end folder, each stream's new records' folders and path keys, and repos holding a spooled
 * commit for this session. Nothing else is read, kept or sent. Granted repos become sticky repo targets; the rest are
 * recorded by NAME as undecided (R8) and capture nothing. A folder target exists only in `end` mode, after every line was
 * read, when no repo at all was named and the launch folder is granted (R6 · R18).
 */
export function resolveTargets(ctx) {
    // A record describes ONE transcript. The same session id arriving with a DIFFERENT `transcript_path` (D58's shape: one id, two
    // repos, two files) is not a continuation of that file's scan: its cursors would skip bytes of the new file and its sticky
    // targets would send the new file's bytes through the old file's ledgers. Start a fresh record for it. Nothing re-sends: the
    // ledgers outlive the record and are ADOPTED by key, and a C3 stop is about the target, so it is kept.
    const loaded = loadTargetRecord(ctx.home, ctx.sessionId);
    const record0 = loaded === null
        ? emptyTargetRecord(ctx.sessionId)
        : loaded.transcriptPath === null || sameTranscript(loaded.transcriptPath, ctx.transcriptPath)
            ? loaded
            : { ...emptyTargetRecord(ctx.sessionId), stopped: loaded.stopped };
    const window = ctx.seams?.scanWindowBytes ?? EVIDENCE_SCAN_WINDOW_BYTES;
    const spec = evidenceSpecFor(ctx.home, ctx.env, ctx.transcriptPath);
    // ⛔ C14 / C24 (P1, from W1's and P2's reviews): EVIDENCE BEYOND THE TURN-END FOLDER (record paths, spooled commits, ledger notes, a
    // launch folder) MAY CREATE A TARGET ONLY FOR A DIALECT THAT CAN ISOLATE RECORDS (`isolatesContentRecords`): one whose every content
    // record carries or inherits the folder it ran in. A path found in a record names a repo, but without R17 isolation the copy for that
    // repo would also carry the prompts, outputs and prose of every other repo's records: the multi-repo leak D19 exists to prevent.
    // `cwdKeys` being non-empty is not enough (Codex names a folder only on two record types), so a dialect that cannot isolate keeps what
    // 0.7.0 and 0.8.0 did: the repo the turn ended in, never a folder target, and no transcript is read for evidence at all. That is now
    // Cursor only: Codex isolates its records (part (b), `codex_folders.ts`) and is read for evidence like Claude Code. The gate is HERE,
    // where hook, drain, finalize and backfill all pass.
    const evidenced = dialectIsolates(ctx.home, ctx.env, ctx.transcriptPath);
    const listing = evidenced ? findSubagentTranscriptsChecked(ctx.home, ctx.env, ctx.transcriptPath) : { found: [], listFailed: false };
    const streams = !evidenced
        ? []
        : [{ fileKey: "main", path: ctx.transcriptPath }, ...listing.found.map((f) => ({ fileKey: f.fileKey, path: f.path }))];
    // --- 1. Read new bytes of every stream, bounded in bytes READ. -----------------------------------------------------------
    const scan = { ...record0.scan };
    const calls = { ...record0.calls };
    const folders = { ...record0.folders };
    let folderUnknown = record0.folderUnknown === true;
    // ⛔ FINAL for TAIL purposes: the session is over (`end`), or it has been idle long enough for another session's firing to
    // drain it (P1 C10 (c)). A crashed session never gets a SessionEnd, so its torn last line would otherwise stay "unconsumed"
    // forever: never `settled`, re-picked by every drain. This decides nothing else: a FOLDER target still needs mode `end` (D21).
    const finalTail = ctx.mode === "end" || ctx.drain === true;
    let launchFolder = record0.launchFolder;
    let oversize = record0.oversize;
    // An unlistable subagents directory is not an empty one (C17 #2): the delegated streams are unknown, so discovery is not exhausted.
    let allRead = !listing.listFailed;
    let anyTorn = false;
    const dirs = [];
    if (ctx.turnEndCwd !== null)
        dirs.push(ctx.turnEndCwd);
    for (const stream of streams) {
        // C35 (ii): a beat before each stream's scan, as before each root: a holder that stalled past its bound must not go on to save a
        // record over its new owner's. `LockLostError` is thrown before anything is written.
        if (ctx.heartbeat !== undefined && !ctx.heartbeat())
            throw new LockLostError();
        const prior = scan[stream.fileKey];
        const from = prior === undefined ? 0 : prior.offset;
        const result = scanTranscriptKeys(stream.path, from, from + window, spec, {
            includeUnterminatedTail: finalTail,
            maxLineBytes: ctx.seams?.maxLineBytes,
            maxDistinctHits: ctx.seams?.maxDistinctHits,
            maxReadBytes: window,
            continueSkipping: prior?.skipping === true,
            ...(spec.codexFolders === true
                ? {
                    codex: {
                        turn: lastFolderOf(folders[stream.fileKey]),
                        sessions: folders[stream.fileKey]?.sessions ?? [],
                        cells: folders[stream.fileKey]?.cells ?? [],
                        openCalls: openCallsAt(calls[stream.fileKey], from),
                        calls: (id) => persistedCall(calls[stream.fileKey], id, from, false),
                        seen: (id) => seenCallId(calls[stream.fileKey], id),
                    },
                }
                : {}),
        });
        if (result.kind === "unreadable") {
            // Q4: no NEW targets from an unreadable stream this firing; sticky targets still deliver. Never complete.
            allRead = false;
            continue;
        }
        // A file that SHRANK was replaced: restart its scan rather than skip bytes it never read.
        if (prior !== undefined && result.size < prior.offset) {
            allRead = false;
            delete scan[stream.fileKey];
            delete calls[stream.fileKey];
            delete folders[stream.fileKey];
            continue;
        }
        // C40 (1): the call checkpoint, from the bytes just read. A stream with a saved cursor but no log (scanned before the checkpoint existed)
        // begins its log overflowed: the calls before its cursor are unknown, so its unmatched results are withheld.
        const priorLog = calls[stream.fileKey] ?? (prior === undefined ? FRESH_CALL_LOG : { entries: [], horizon: prior.offset, overflowed: true });
        // C45 (2): only bytes the scan did not READ (an oversize line) make the call log unreliable. `result.capped` also means a walk was TRUNCATED (or the
        // distinct-hit cap was reached), which is about the evidence and, for a call, already marks that one entry INCOMPLETE; it must not set the sticky overflow.
        calls[stream.fileKey] = applyCallEvents(priorLog, result.calls, result.oversizeLines > 0);
        if (spec.codexFolders === true) {
            // Part (b): the turn-folder timeline, the session and cell maps, and whether any record's folder could not be told. An output whose call is not
            // in the table (a dropped one included) is unknown: the call table is what places it.
            if (result.folders.unknown)
                folderUnknown = true;
            const changes = [...(folders[stream.fileKey]?.changes ?? []), ...result.folders.changes];
            folders[stream.fileKey] = {
                changes: boundedChanges(changes),
                // The maps are bounded by the tracker (live entries, tombstones and the whole-map mark); `boundedIdEntries` is only a backstop, and it never cuts
                // silently: past the bound the whole map is marked UNKNOWN (C56 (12)).
                sessions: boundedIdEntries(result.folders.sessions),
                cells: boundedIdEntries(result.folders.cells),
                ...(folders[stream.fileKey]?.skipped !== undefined || result.folders.skipped !== undefined ? { skipped: folders[stream.fileKey]?.skipped ?? result.folders.skipped } : {}),
            };
        }
        scan[stream.fileKey] = {
            offset: result.scannedTo,
            size: result.size,
            ...(result.skipping ? { skipping: true } : {}),
        };
        // The furthest point this stream can EVER reach: its end, or, for a FINAL file, a torn tail (nothing more will parse) or an
        // oversize skip that ran to the end (nothing more will be buffered). Anything short of that, a later firing can still read.
        const furthest = (!result.skipping && result.scannedTo >= result.size) ||
            result.torn ||
            (result.skipping && result.scannedTo >= result.size && finalTail);
        if (!furthest)
            allRead = false;
        if (result.torn)
            anyTorn = true;
        if (result.oversizeLines > 0 || result.capped)
            oversize = true;
        for (const hit of result.hits) {
            if (hit.kind === "cwd" && launchFolder === null && stream.fileKey === "main")
                launchFolder = hit.value;
            dirs.push(hit.value);
        }
    }
    // C76 (3): the SESSION's budget over every stream's tables (a session can have any number of subagent streams, each with tables of its own). A Codex id map that lost evidence counts the
    // session as multi, like any other lost evidence.
    if (shedSession(calls, folders))
        oversize = true;
    // A stream not scanned at all (first sight, or unreadable): unfinished.
    for (const stream of streams)
        if (scan[stream.fileKey] === undefined)
            allRead = false;
    // ⛔ A stream with a saved UNFINISHED cursor that is no longer listed (the file vanished) keeps the session incomplete (#7).
    const listed = new Set(streams.map((stream) => stream.fileKey));
    for (const [fileKey, cursor] of Object.entries(record0.scan)) {
        if (!listed.has(fileKey) && (cursor.offset < cursor.size || cursor.skipping === true))
            allRead = false;
    }
    // --- 2. Collapse to candidate roots by `stat` (no spawn), then resolve a bounded number. ---------------------------------
    const files = sessionFiles(ctx.home, ctx.sessionId);
    // Likewise an unlistable sessions directory: "no spool, no ledger" is unknown, not known.
    if (files.listFailed)
        allRead = false;
    const cache = new Map();
    const unresolvableCache = new Map();
    const candidates = [];
    const evidenceRoots = new Set();
    const noteCandidate = (dir, viaEvidence) => {
        const root = workTreeRootOf(dir, cache);
        // C50 (3): evidence that names a place nobody can resolve cannot be ruled out as another work tree: the status is unknown (multi), like a dropped hit.
        if (root === null && viaEvidence && unresolvable(dir, unresolvableCache))
            oversize = true;
        if (root === null)
            return;
        if (viaEvidence)
            evidenceRoots.add(root);
        if (!candidates.includes(root))
            candidates.push(root);
    };
    for (const dir of dirs)
        noteCandidate(dir, true);
    if (evidenced) {
        for (const key of files.spoolKeys)
            noteCandidate(key, true);
        for (const key of files.ledgerKeys)
            noteCandidate(key, false);
    }
    // ⛔ A root that evidence named but the per-firing cap (or the spawn window) deferred is still evidence-origin on the next firing, even
    // when only its ledger note supplies it then (C17 #6): only a root that was ledger-only to begin with stays ledger-only.
    for (const root of record0.unresolved)
        if (!record0.ledgerOnly.includes(root))
            evidenceRoots.add(root);
    // A root is ledger-only until evidence names it, and once evidence has, it never goes back.
    const ledgerOnly = new Set(record0.ledgerOnly.filter((root) => !evidenceRoots.has(root)));
    for (const root of candidates)
        if (!evidenceRoots.has(root) && record0.roots[root] === undefined)
            ledgerOnly.add(root);
    const roots = { ...record0.roots };
    const queue = [...record0.unresolved];
    for (const root of candidates)
        if (!queue.includes(root) && roots[root] === undefined)
            queue.push(root);
    const cap = ctx.seams?.maxNewRoots ?? MAX_NEW_ROOTS_PER_FIRING;
    // ⛔ Not reached this firing (cap, spawn window) keep their place; ones that were TRIED and failed rotate to the BACK, so eight roots
    // that fail for ever cannot hold every slot while a healthy ninth waits (C17 #11).
    const waiting = [];
    const failedNow = [];
    const failures = { ...record0.failures };
    let spent = 0;
    for (const root of queue) {
        if (roots[root] !== undefined)
            continue;
        if (spent >= cap) {
            waiting.push(root);
            continue;
        }
        spent += 1;
        if (ctx.heartbeat !== undefined && !ctx.heartbeat())
            throw new LockLostError();
        const info = nameRoot(root, ctx);
        if (info === null) {
            waiting.push(root);
            continue;
        }
        if (info === "unnamed") {
            if (ctx.countedThisInvocation === undefined || !ctx.countedThisInvocation.has(root)) {
                failures[root] = (failures[root] ?? 0) + 1;
                ctx.countedThisInvocation?.add(root);
            }
            if ((failures[root] ?? 0) >= MAX_NAMING_FAILURES)
                roots[root] = { state: "nonrepo" };
            else
                failedNow.push(root);
            continue;
        }
        roots[root] = info;
    }
    const unresolved = [...waiting, ...failedNow];
    // EXHAUSTED: nothing a later firing could still discover (P1's definition of `settled`). NOT the same as `complete`: an oversize
    // line only rules out the FOLDER decision, and repo discovery must still reach the end of the file.
    const exhausted = allRead && unresolved.length === 0;
    const discoveryDone = exhausted;
    // --- 3. Group resolved repos by slug; consent decides what becomes a sticky target. ------------------------------------
    const turnEndRoot = ctx.turnEndCwd === null ? null : workTreeRootOf(ctx.turnEndCwd, cache);
    const bySlug = new Map();
    for (const [root, info] of Object.entries(roots)) {
        if (info.state !== "repo")
            continue;
        const standing = captureStanding(ctx.home, { worktree: info.toplevel, consent: info.commonDir }, info.slug);
        const key = groupKey(info);
        const members = bySlug.get(key) ?? [];
        members.push({ root, info, standing, viaLedgerOnly: ledgerOnly.has(root) });
        bySlug.set(key, members);
    }
    // Ledger digests no resolved repo accounts for yet: an existing 0.8.0 ledger whose work tree discovery has not reached (#3).
    const accountedDigests = new Set(Object.values(roots).flatMap((info) => (info.state === "repo" ? [repoKeyDigest(info.toplevel)] : [])));
    const unaccountedLedger = files.ledgerDigests.some((digest) => !accountedDigests.has(digest));
    const targets = [];
    const undecided = [];
    const sticky = new Map(record0.targets.filter((t) => t.kind === "repo").map((t) => [t.groupKey ?? normalizeSlug(t.slug), t]));
    const keep = [];
    const newKeys = new Set();
    for (const [key, members] of bySlug) {
        // A group no evidence named (only ledger notes) is not this transcript's repo: it makes no target and no undecided name.
        if (members.every((m) => m.viaLedgerOnly))
            continue;
        const granted = members.filter((m) => m.standing === "granted");
        if (granted.length === 0) {
            if (members.every((m) => m.standing === "undecided")) {
                const first = members[0].info;
                undecided.push({ kind: "repo", name: first.slug.startsWith("local:") ? first.toplevel : first.slug, at: ctx.nowMs });
            }
            // A sticky target whose consent was withdrawn is kept in the record but not returned (denied/held).
            const old = sticky.get(key);
            if (old !== undefined)
                keep.push(old);
            continue;
        }
        // ⛔ C28 (Codex's P1 on 47220fa): A DIALECT THAT CANNOT ISOLATE (Cursor; Codex until its own isolation is built) DELIVERS ONLY THE REPO
        // THE CURRENT TURN ENDED IN, the 0.7.0/0.8.0 rule. A repo an EARLIER turn ended in is a sticky target of this record, and returning
        // it would send this turn's records (another repo's prompts and output) into ITS copy: turn 1 ends in A, turn 2 ends in B, and B's turn
        // would reach A. The sticky target stays in the record with its ledger (a later turn that ends in A continues A's offset), it is
        // just not deliverable now. Every caller passes the turn-end folder it means (hook: its cwd; in-repo backfill: the candidate's
        // folder) or none (`finalize`, the parent-folder backfill, the idle drain), and none means no target for such a dialect.
        // C35 (i): the root must belong to a GRANTED member, not merely to the group. Consent can be per clone: of two clones of one remote
        // only A granted, a turn that ends in B must send nothing (0.8.0 sent nothing), not ride A's ledger and slug.
        if (!evidenced && !granted.some((m) => m.root === turnEndRoot)) {
            const stuck = sticky.get(key);
            if (stuck !== undefined)
                keep.push(stuck);
            continue;
        }
        // The turn-end work tree first (today's behaviour, R14), then first-seen order.
        const ordered = [...granted].sort((a, b) => Number(b.root === turnEndRoot) - Number(a.root === turnEndRoot));
        const worktrees = [...new Set(ordered.map((m) => m.info.toplevel))];
        const redaction = [...new Set(ordered.flatMap((m) => m.info.roots))];
        const old = sticky.get(key);
        let chosen;
        if (old !== undefined) {
            chosen = { ledgerKey: old.ledgerKey, setAside: [...old.setAsideLedgers] };
        }
        else {
            const picked = chooseLedger(ctx.home, ctx.sessionId, worktrees);
            // ⛔ DEFER, never start a second ledger (#3): with no ledger among the worktrees found so far, but a ledger for this
            // session that discovery has not mapped to any work tree yet, the first-seen choice could rewind the server stream
            // (P9). Wait for discovery; once it is done with the ledger still unaccounted for, it belongs to something that no
            // longer exists and a new ledger is the only option left.
            // C17 #7: also when a ledger WAS adopted. If A's older ledger is found first while B's newer ledger is still an unmapped digest,
            // making A sticky now could rewind B's server stream: wait until every ledger digest of this session is accounted for.
            if (unaccountedLedger && !discoveryDone)
                continue;
            chosen = picked;
            newKeys.add(key);
        }
        // ⛔ The wire slug is bound to the LEDGER, not to this firing's turn-end (P1 C10): a no-remote group holds work trees with
        // different `local:<hash>` slugs, so recomputing it per firing would send one ledger's offsets to two server repos (a gapped
        // stream each), and an adopted 0.8.0 ledger written under work tree X would send X's offsets to local:<Y>. A new target takes
        // the slug (and common dir) of the member whose work tree IS the chosen ledger key and stores it; a sticky target reuses what
        // it stored for the session's life. Only worktrees and redaction roots grow. Remote groups share one slug, so nothing changes.
        const owner = ordered.find((m) => m.info.toplevel === chosen.ledgerKey) ?? ordered[0];
        // C27: has this session named a work tree OTHER than this group's? Any resolved root outside the group, granted or not (an unnameable `.git`
        // counts: it is a work tree), any candidate not yet resolved, or evidence dropped (oversize / capped: the status is unknown). Ledger-only
        // roots are not evidence about this transcript. Monotonic: a target that was multi stays multi.
        const namedOther = oversize ||
            unresolved.length > 0 ||
            Object.entries(roots).some(([root, info]) => !ledgerOnly.has(root) && (info.state !== "repo" || groupKey(info) !== key));
        const target = {
            ...(old?.multi === true || namedOther ? { multi: true } : {}),
            kind: "repo",
            slug: old?.slug ?? owner.info.slug,
            groupKey: key,
            ledgerKey: chosen.ledgerKey,
            redactionRoots: redaction,
            worktrees,
            commonDir: old?.commonDir ?? owner.info.commonDir,
            setAsideLedgers: chosen.setAside,
        };
        keep.push(target);
        targets.push(target);
    }
    // --- 4. A folder target: only when the session is OVER, fully read, and named no repo at all (R6 · R18). ----------------
    const complete = exhausted && !oversize && !files.unmappedSpool && !anyTorn;
    // Part (b): a Codex session whose records' folders were not all determined has no folder target (every record must be placeable before the whole
    // session is sent under a folder's name).
    const foldersKnown = !folderUnknown;
    // ⛔ ANY candidate root is repo evidence, whatever naming it said (P2 F1): a `.git` git will not name is still a repo, and
    // R6 gives a folder target only when evidence finds NO repo at all.
    const namedAnyRepo = Object.keys(roots).length > 0 || unresolved.length > 0 || files.spoolKeys.length > 0 || files.unmappedSpool;
    const folderStanding = ctx.seams?.folderStanding ?? ((real) => folderStandingOf(ctx.home, real));
    let folderTarget = null;
    const stickyFolder = record0.targets.find((t) => t.kind === "folder") ?? null;
    // The folder target's OWN ledger is not "a repo stream existed": exclude its digest from the unmapped-ledger evidence.
    const folderDigest = stickyFolder === null ? null : repoKeyDigest(stickyFolder.ledgerKey);
    const foreignLedger = files.ledgerDigests.some((digest) => digest !== folderDigest && !accountedDigests.has(digest));
    const noRepoEvidence = !namedAnyRepo && !foreignLedger;
    if (!evidenced) {
        // C14: a dialect with no recorded folder has no launch folder, so it never gets a folder target.
    }
    else if (stickyFolder !== null) {
        // ⛔ Re-checked on EVERY return (#5), INCLUDING completeness: a resumed session whose new bytes are not yet scanned gets no
        // folder target, because it would deliver bytes discovery has not seen. A grant withdrawn, or repo evidence appearing later,
        // stops it too. A sticky folder does NOT need `end` mode: a Stop or the idle drain may deliver it once the scan is complete.
        if (complete && foldersKnown && noRepoEvidence && folderStanding(stickyFolder.folder ?? "") === "granted")
            folderTarget = stickyFolder;
    }
    else if (ctx.mode === "end" && complete && foldersKnown && noRepoEvidence && launchFolder !== null) {
        const real = realOrNull(launchFolder);
        if (real !== null) {
            const standing = folderStanding(real);
            if (standing === "granted") {
                folderTarget = {
                    kind: "folder",
                    slug: folderSlug(real),
                    ledgerKey: folderLedgerKey(real),
                    redactionRoots: [real],
                    worktrees: [],
                    commonDir: null,
                    folder: real,
                    setAsideLedgers: [],
                };
            }
            else if (standing === "undecided") {
                undecided.push({ kind: "folder", name: real, at: ctx.nowMs });
            }
        }
    }
    if (folderTarget !== null) {
        keep.push(folderTarget);
        targets.push(folderTarget);
    }
    else if (stickyFolder !== null) {
        // ⛔ A sticky folder that is WITHHELD this firing (incomplete scan, consent withdrawn) stays in the record, exactly as a repo target
        // whose consent was withdrawn does (C17 #5): dropping it would make its own ledger read as a foreign one and the folder could
        // never come back.
        keep.push(stickyFolder);
    }
    // C40 (1): an entry is removed once EVERY copy of the session is past its result: the smallest sent offset of the stream over the targets that
    // can still send. No such target (none yet) prunes nothing.
    const live = keep.filter((t) => record0.stopped[stopKeyOf(t)] === undefined);
    if (live.length > 0) {
        const ledgers = live.map((t) => loadSessionState(ctx.home, { repoKey: t.ledgerKey, sessionId: ctx.sessionId }));
        for (const [fileKey, log] of Object.entries(calls)) {
            calls[fileKey] = pruneCalls(log, Math.min(...ledgers.map((ledger) => fileState(ledger, fileKey).sentOffset)));
        }
    }
    const turnEndInfo = turnEndRoot === null ? undefined : roots[turnEndRoot];
    const turnEndSlug = turnEndInfo?.state === "repo" ? normalizeSlug(turnEndInfo.slug) : null;
    const record = {
        v: 1,
        sessionId: ctx.sessionId,
        launchFolder,
        scan,
        calls,
        folders,
        ...(folderUnknown ? { folderUnknown: true } : {}),
        oversize,
        failures,
        roots,
        unresolved,
        ledgerOnly: [...ledgerOnly],
        targets: keep,
        undecided,
        stopped: record0.stopped,
        settled: exhausted,
        transcriptPath: ctx.transcriptPath,
        firedAt: ctx.drain === true ? record0.firedAt : ctx.nowMs,
        updatedAt: ctx.nowMs,
    };
    // ⛔ A record that cannot be persisted cannot make a NEW target sticky (#11): its ledger key would be re-chosen next firing,
    // possibly differently. New targets defer; sticky ones still deliver. The caller is told.
    // C35 (ii): and one right before the save, the resolver's only write.
    if (ctx.heartbeat !== undefined && !ctx.heartbeat())
        throw new LockLostError();
    const persisted = saveTargetRecord(ctx.home, record);
    const deliverable = (persisted
        ? targets
        : targets.filter((t) => (t.kind === "repo" ? !newKeys.has(t.groupKey ?? normalizeSlug(t.slug)) : stickyFolder !== null))).filter((t) => record0.stopped[stopKeyOf(t)] === undefined);
    return { targets: deliverable, undecided, complete, settled: exhausted, persisted, turnEndSlug, record };
}
/** The key a target is stopped under (`TargetRecord.stopped`): its repo group, or its folder slug. */
export function stopKeyOf(target) {
    return target.kind === "repo" ? (target.groupKey ?? normalizeSlug(target.slug)) : target.slug;
}
/**
 * Stop ONE target for the rest of the session (C3: `folder_repository_forbidden`). Sticky, per target, never credential-wide;
 * `status` names it. Returns false when the record could not be written (the target then retries and is refused again, which
 * costs a request, not a byte).
 */
export function stopTarget(home, sessionId, target, code, nowMs) {
    const record = loadTargetRecord(home, sessionId);
    if (record === null)
        return false;
    const key = stopKeyOf(target);
    return saveTargetRecord(home, { ...record, stopped: { ...record.stopped, [key]: { at: nowMs, code } } });
}
/**
 * Whether two spellings name one transcript file. finalize, backfill and the drain build the path their own way, so a symlinked
 * home or a trailing component must not read as "a different transcript" (that would reset the record on every switch). Compared
 * by realpath; a side that is gone falls back to the string compare.
 */
function sameTranscript(a, b) {
    if (a === b)
        return true;
    const ra = realOrNull(a);
    const rb = realOrNull(b);
    return ra !== null && rb !== null && ra === rb;
}
function realOrNull(path) {
    // C71 (3): the one resolver (a path that does not exist is null).
    return physicalPath(path, "fail");
}
//# sourceMappingURL=session_targets.js.map