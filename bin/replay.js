/**
 * REPLAY ONE STEP OF ONE SESSION'S FIRING LOG — U5a of the detached uploader (plan §3.3).
 *
 * The hook's job used to be "read the transcript, resolve targets, send". It now only records a firing (U6); this module is the
 * other half: take the session's oldest unconsumed firing, **alone** (D15, firings never merge), and run it through `deliverFiring`
 * with the values recorded at the moment the hook fired. The upload worker calls it in a loop, one session at a time. `finalize` and
 * `backfill` call the same function under their own lock (U5b), so promotion stays at one call site.
 *
 * A STEP is at most one delta per target (`DeliveryContext.oneDelta`) and either advances the cursor past the firing (`done`), leaves it
 * where it is (`more`, `later`, `threw`, `lost`), or leaves the whole session alone (`busy`, `foreign`, `newer`, `idle`).
 *
 * ## ⛔ THE CURSOR MOVES ONLY WHEN THE FIRING IS DONE, and "done" is never read from `Delivery.kind` alone
 * `nothing-to-send` also means a lost lock, a failed read, an unterminated record or a cutter that threw, and `ok` can be one delta of
 * several. `deliverFiring` returns a `TargetReason` per target (U4) and this module is the one place those are folded into a decision:
 *
 *   lock-lost > fatal > later > not-progressed > more-owed > done
 *
 * A target that is `held` (not approved, stopped, an unterminated record that may still grow, a forbidden folder) or `never` counts as done
 * FOR THIS FIRING, and never holds back another target: its bytes stay owed in its ledger and ride its next delivery.
 *
 * ## ⛔ EVERY CURSOR WRITE BEATS FIRST. A worker that lost its session lock writes nothing, not even a cursor.
 *
 * ## ⛔ Paths and numbers only. A firing holds no credential and no transcript text; the credential is loaded here, each round, from the
 * file or the inherited environment (`loadCredential`), so `vibecommit auth` takes effect at once and the worker keeps no copy.
 */
import { loadCredential } from "./credential.js";
import { noteCredentialExpiry } from "./credential_meta.js";
import { advanced, readCursor, readFirings, shouldSkip, stampLive, threw, writeCursor, } from "./firing.js";
import { admitsTranscript, canonicalHookEvent, dialectFor } from "./agents/registry.js";
import { DEFAULT_HOOK_BUDGET_MS, deliverFiring, fileSize, turnEndCwd, wait, } from "./hooks/entry.js";
import { claimSessionWriter } from "./hooks/fire_lock.js";
import { SESSION_END_EVENT, settleDelayMs, settledSize } from "./hooks/session_end.js";
import { CAPTURE_NOT_APPROVED, credentialFingerprint } from "./post.js";
import { sessionFileStem } from "./paths.js";
import { LockLostError, resolveTargets } from "./session_targets.js";
import { gitToplevel } from "./project.js";
/** The request timeout of the worker (plan §3.12): finite, longer than the slowest request observed (44 s), shorter than undici's own. */
export const REQUEST_TIMEOUT_MS = 120_000;
/** How often the worker re-stamps a session lock it holds, from a timer, whatever its request is doing. */
export const SESSION_BEAT_MS = 15_000;
/**
 * How long a session lock may sit unbeaten before anyone may reclaim it: four beats, like the uploader lock. It was a request timeout plus 30 s
 * (150 s) when only the per-request beats kept it alive; U8 measured a SIGKILLed worker's lock blocking `finalize` for 152.8 s. A live holder beats
 * from a timer (`SESSION_BEAT_MS`), so a 120 s request no longer needs a lock that outlives it.
 */
export const SESSION_LOCK_STALE_MS = 4 * SESSION_BEAT_MS;
/**
 * Run the oldest unconsumed firing of one session for one step.
 *
 * `stem` is the log's file stem (`firingSessions`); the id sent on the wire is the firing's own `sid`.
 */
export async function replayStep(cfg, stem) {
    // A cheap look first, with no lock: most sessions most rounds have nothing to do.
    const peek = readFirings(cfg.home, stem, readCursor(cfg.home, stem).offset);
    if (peek.firings.length === 0)
        return peek.blockedByNewer ? { kind: "newer" } : { kind: "idle" };
    const lock = await claimSessionWriter(cfg.home, peek.firings[0].firing.sid, {
        staleAfterMs: SESSION_LOCK_STALE_MS,
        // The worker never waits for a session writer: a busy session is skipped and revisited.
        deadlineAtMs: 0,
        wait,
    });
    if (lock === null)
        return { kind: "busy" };
    // A timer beat on top of the per-request beats, so a long request cannot let the lock go stale under a live holder.
    const beat = setInterval(() => lock.refresh(), SESSION_BEAT_MS);
    beat.unref();
    try {
        return await stepUnderLock(cfg, stem, lock);
    }
    finally {
        clearInterval(beat);
        lock.release();
    }
}
async function stepUnderLock(cfg, stem, lock) {
    const startedAt = Date.now();
    const elapsed = () => Date.now() - startedAt;
    // Read again UNDER the lock: the cursor is only ever written by a holder of it, so this is the truth.
    const cursor = readCursor(cfg.home, stem);
    const read = readFirings(cfg.home, stem, cursor.offset);
    const first = read.firings[0];
    if (first === undefined)
        return read.blockedByNewer ? { kind: "newer" } : { kind: "idle" };
    const finish = (klass, requested, roots) => {
        // ⛔ Beat first: a holder that lost the lock must not move the cursor of the session's new owner.
        if (!lock.refresh())
            return { kind: "lost" };
        return writeCursor(cfg.home, stem, advanced(cursor, first.end))
            ? { kind: "done", class: klass, elapsedMs: elapsed(), ...(requested === true ? { requested: true } : {}), ...(roots === undefined ? {} : { roots }) }
            : { kind: "threw", class: "cursor-unwritable", elapsedMs: elapsed() };
    };
    if (first.firing.id !== cfg.identity) {
        // A session's lines can name two identities (it resumed under another token). One cursor per session: skip this line only when a later
        // line of OURS exists, since a firing only sets an EOF and the later one covers those bytes. Otherwise leave the session as it is.
        return read.firings.some((r) => r.firing.id === cfg.identity) ? finish("skipped-other-identity") : { kind: "foreign" };
    }
    if (shouldSkip(cursor)) {
        if (!lock.refresh())
            return { kind: "lost" };
        return writeCursor(cfg.home, stem, advanced(cursor, first.end))
            ? { kind: "done", class: "skipped-throws", elapsedMs: elapsed() }
            : { kind: "threw", class: "cursor-unwritable", elapsedMs: elapsed() };
    }
    let outcome;
    try {
        outcome = await deliverOne(cfg, first, () => lock.refresh(), read.firings.length === 1);
    }
    catch (error) {
        if (error instanceof LockLostError)
            return { kind: "lost" };
        // An uncaught throw is counted on the firing it happened on (not on the session), and its CLASS is kept: a message could carry a path.
        if (!lock.refresh())
            return { kind: "lost" };
        writeCursor(cfg.home, stem, threw(cursor));
        return { kind: "threw", class: error instanceof Error ? error.name : "non-error", elapsedMs: elapsed() };
    }
    cfg.beforeCursorWrite?.();
    switch (outcome.kind) {
        case "done":
            return finish(outcome.class, outcome.requested, outcome.roots);
        case "more":
            return { kind: "more", elapsedMs: elapsed() };
        case "later":
            return { kind: "later", elapsedMs: elapsed(), ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }) };
        case "fatal":
            return { kind: "fatal", why: outcome.why, elapsedMs: elapsed(), ...(outcome.fingerprint === undefined ? {} : { fingerprint: outcome.fingerprint }) };
        case "lost":
            return { kind: "lost" };
        case "threw":
            if (!lock.refresh())
                return { kind: "lost" };
            writeCursor(cfg.home, stem, threw(cursor));
            return { kind: "threw", class: outcome.class, elapsedMs: elapsed() };
    }
}
async function deliverOne(cfg, read, heartbeat, isLastLine) {
    const f = read.firing;
    // ⛔ RE-CONFINED on every replay, as the idle drain re-confines a path read from state: a firing is a file on disk, and the transcript it
    // names may have been replaced since the hook wrote it.
    if (!admitsTranscript(cfg.home, cfg.env, f.transcript))
        return { kind: "done", class: "unadmitted" };
    const ctx = {
        env: cfg.env,
        home: cfg.home,
        nodeVersion: cfg.nodeVersion,
        ...(cfg.selfPath === undefined ? {} : { selfPath: cfg.selfPath }),
        agentId: f.agent,
        readStdin: () => Promise.resolve(""),
    };
    // ⛔ U11 (recovery): a Cursor firing the HOOK could not resolve (its spawn window refused or timed out a `git` call, or a hook ran from the config folder)
    // carries the workspace roots it parsed. The worker has no window, so it re-runs the SAME `turnEndCwd` the hook runs (one function, imported, not copied)
    // and, if that names a work tree, resolves from it. Everything after is the ordinary path: `resolveTargets` applies `isCaptureAllowed` exactly as it does for
    // a hook-resolved firing, so an unconsented clone yields no target (and no install, no stamp). A firing that already has keys is never touched.
    const turnEnd = f.keys === undefined && f.roots !== undefined
        ? turnEndCwd({ home: cfg.home, env: cfg.env }, { cwd: f.cwd, transcriptPath: f.transcript, workspaceRoots: f.roots })
        : f.cwd;
    const input = {
        sessionId: f.sid,
        transcriptPath: f.transcript,
        cwd: turnEnd,
        eventName: f.event,
        ...(f.announced === undefined ? {} : { agentTranscriptPath: f.announced }),
    };
    const event = canonicalHookEvent(dialectFor(f.agent), f.event);
    const isSessionEnd = event === SESSION_END_EVENT;
    // `SessionEnd` is settled HERE, not in the hook: the hook no longer waits (plan §3.1 step 6). Never smaller than the size it recorded.
    //
    // ⛔ U6b (F3): ONLY WHEN THE SESSIONEND IS THE LAST LINE OF THE LOG. A SessionEnd followed by later firings is a session that was RESUMED
    // (`--continue`): settling it to the file's real size and resolving in `end` mode with no scan limit sent the resumed turns under the ENDING, and
    // the resumed Stop then replayed as a no-op (no promotion, no commit lines) yet was recorded as delivered. Such an ending covers what the hook
    // saw (`f.eof`, scan-limited like a Stop); the later firings carry the rest.
    const settle = isSessionEnd && isLastLine;
    let eof = f.eof;
    if (settle) {
        const settled = await settledSize(() => fileSize(f.transcript), wait, settleDelayMs(cfg.env, DEFAULT_HOOK_BUDGET_MS));
        if (settled === null)
            return { kind: "threw", class: "transcript-unreadable" };
        eof = Math.max(eof, settled);
    }
    // The credential is read EVERY round and never kept: `auth` takes effect at once, and a revoked file stops the worker.
    const load = loadCredential({ env: cfg.env, home: cfg.home });
    if (load.kind !== "ok")
        return { kind: "fatal", why: "no-credential" };
    const resolution = resolveTargets({
        home: cfg.home,
        env: cfg.env,
        sessionId: f.sid,
        transcriptPath: f.transcript,
        turnEndCwd: turnEnd,
        mode: isSessionEnd ? "end" : "turn",
        nowMs: Date.now(),
        heartbeat,
        // The evidence scan reads the main stream only up to what the hook saw; at SessionEnd the whole file is the question (R18).
        ...(settle ? {} : { scanLimit: f.eof }),
        ...knownOf(f),
    });
    // Counted, never logged: "recovered" = the roots named a work tree the gate granted; "unresolved" = a firing that carried roots and still has no repo.
    const rootsNote = f.keys === undefined && f.roots !== undefined ? (turnEnd !== f.cwd && resolution.targets.length > 0 ? "recovered" : "unresolved") : undefined;
    if (resolution.targets.length === 0) {
        // Not a failure. But a firing that had a repo and never got a real slug is the one case `status` must be able to name.
        return { kind: "done", class: f.keys !== undefined && f.slug === undefined ? "undeliverable" : "nothing-granted", ...(rootsNote === undefined ? {} : { roots: rootsNote }) };
    }
    if (rootsNote === "recovered") {
        // The hook stamps `.live` for the turn-end repo it resolves; this firing's hook resolved none, so stamp it as of the HOOK's time (`f.at`), for the
        // repo the gate granted. The post-commit ladder reads it.
        const top = gitToplevel(turnEnd);
        if (top !== null && resolution.targets.some((t) => t.kind === "repo" && (t.ledgerKey === top || t.worktrees.includes(top)))) {
            stampLive(cfg.home, { repoKey: top, sessionId: f.sid }, f.at);
        }
    }
    const results = await deliverFiring({
        ctx,
        input,
        url: cfg.url,
        credential: load.credential,
        resolution,
        eof,
        event,
        isSessionEnd,
        pace: { kind: "unbounded", timeoutMs: cfg.requestTimeoutMs ?? REQUEST_TIMEOUT_MS },
        asOf: { at: f.at, prior: f.prior, ...(settle || f.sub === undefined ? {} : { subCap: f.sub }) },
        heartbeat,
    });
    const fingerprint = credentialFingerprint(load.credential);
    noteExpiry(cfg, fingerprint, results);
    const folded = foldResults(results);
    const withNote = (o) => (rootsNote !== undefined && o.kind === "done" ? { ...o, roots: rootsNote } : o);
    // The fingerprint (a hash, never the credential) lets the next hook say "revoked" only about the credential it is about to use.
    return folded.kind === "fatal" && folded.why === "rejected" ? { ...folded, fingerprint } : withNote(folded);
}
/**
 * `credential_ending` (plan §3.7): a 2xx carries where the credential stands (`X-Credential-Expires`). The worker remembers it in the SIDECAR (never
 * in `credentials.json`, which nothing but `auth` writes) and the next hook says so from 14 days before the end. Never throws.
 */
function noteExpiry(cfg, fingerprint, results) {
    try {
        const ok = [...results.map((r) => r.delivery), ...results.flatMap((r) => r.subagents.deliveries)].find((d) => d.kind === "attempted" && d.disposition === "ok" && d.credentialExpires != null);
        if (ok !== undefined && ok.kind === "attempted" && ok.credentialExpires != null) {
            noteCredentialExpiry(cfg.home, cfg.env, fingerprint, ok.credentialExpires, new Date());
        }
    }
    catch {
        // A sidecar that cannot be written costs one warning, not a delivery.
    }
}
/** `known` only when the hook had a REAL slug: a `local:` fallback must never become a target's sticky identity (C17 #13b). */
function knownOf(f) {
    if (f.keys === undefined || f.slug === undefined)
        return {};
    const slug = f.slug;
    return { known: { keys: { worktree: f.keys.worktree, consent: f.keys.consent }, slugOf: () => slug } };
}
/** Fold the per-target reasons (and the sub-agent deliveries) of one `deliverFiring` call into the step's decision. Pure. */
export function foldResults(results) {
    const reasons = results.map((r) => r.reason.kind);
    if (reasons.includes("lock-lost"))
        return { kind: "lost" };
    const subagents = results.flatMap((r) => r.subagents.deliveries);
    // A sub-agent delivery that did not PROGRESS (the lock was lost, or its span could not be read or its ledger written) is not "done": the next firing's
    // main would seal a turn whose sub-agent bytes are still owed (plan §3.3). Folded like main's `not-progressed`, so it is counted toward the 3-throw skip.
    if (subagents.some((d) => d.kind === "nothing-to-send" && d.why === "lock-lost"))
        return { kind: "lost" };
    const subFatal = subagents.some((d) => d.kind === "attempted" && d.disposition === "fatal");
    if (reasons.includes("fatal") || subFatal)
        return { kind: "fatal", why: "rejected" };
    // A sub-agent file the server has not approved is a RECORDED hold (its bytes stay owed), not a failure to back off from.
    const subLater = subagents.some((d) => d.kind === "attempted" && d.disposition === "later" && d.detail?.code !== CAPTURE_NOT_APPROVED);
    if (reasons.includes("later") || subLater) {
        // The server's `Retry-After`, the LARGEST one seen in this step (main or sub-agent): asking sooner re-sends a body of up to 8 MiB to the VM that just throttled us.
        const waits = [...results.map((r) => r.delivery), ...subagents].flatMap((d) => (d.kind === "attempted" && d.disposition === "later" && d.retryAfterMs !== undefined ? [d.retryAfterMs] : []));
        return waits.length === 0 ? { kind: "later" } : { kind: "later", retryAfterMs: Math.max(...waits) };
    }
    const notProgressed = results.find((r) => r.reason.kind === "not-progressed");
    if (notProgressed !== undefined)
        return { kind: "threw", class: `not-progressed:${notProgressed.reason.why}` };
    const subStuck = subagents.find((d) => d.kind === "nothing-to-send" && (d.why === "read-failed" || d.why === "unwritable"));
    if (subStuck !== undefined && subStuck.kind === "nothing-to-send")
        return { kind: "threw", class: `not-progressed:sub-${subStuck.why}` };
    const subMore = subagents.some((d) => d.kind === "attempted" && d.more === true);
    if (reasons.includes("more-owed") || subMore)
        return { kind: "more" };
    // Nothing was attempted anywhere (main or sub-agent) => this firing delivered nothing new.
    const attempted = [...results.map((r) => r.delivery), ...subagents].some((d) => d.kind === "attempted");
    if (reasons.length > 0 && reasons.every((kind) => kind === "held"))
        return { kind: "done", class: "held", ...(attempted ? { requested: true } : {}) };
    if (!attempted)
        return { kind: "done", class: "noop" };
    return { kind: "done", class: "delivered" };
}
/** A safety bound, not a limit anyone should meet: a firing is consumed or the loop stops, so it is finite. */
const MAX_REPLAY_STEPS = 100_000;
/**
 * U5b — REPLAY A SESSION'S WHOLE LOG UNDER A LOCK THE CALLER ALREADY HOLDS (`finalize`, `backfill`). The same `stepUnderLock` the worker
 * runs, so promotion has one call site, looped until the log is empty. `finalize` and `backfill` call it BEFORE they read the spool union or
 * decide whether the session exists: after U6 the hook no longer promotes or writes the state file, so without this a one-shot's pending
 * commit line would miss the sealing request, and `--session` would call a session the worker has not reached "unknown".
 *
 * `clean`: nothing is owed. This includes a firing of ANOTHER identity (`foreign`): that worker's credential is not ours to use, and the bytes
 * it covers are sent by the close itself, which drains from `sentOffset` to the end of the file.
 * `stopped`: anything that left a firing of OUR identity unconsumed (`later`, `fatal`, `threw`, `lost`) or a line of a NEWER build this one
 * cannot read. The caller reports it and sends no `final`: sealing would strand what the stopped firing still owes.
 */
export async function replayAllUnderLock(cfg, sessionId, held) {
    const stem = sessionFileStem(sessionId);
    for (let steps = 0; steps < MAX_REPLAY_STEPS; steps += 1) {
        const step = await stepUnderLock(cfg, stem, held);
        switch (step.kind) {
            case "idle":
            case "foreign":
                return { kind: "clean", steps };
            case "done":
            case "more":
                continue;
            default:
                return { kind: "stopped", step };
        }
    }
    return { kind: "stopped", step: { kind: "threw", class: "replay-bound", elapsedMs: 0 } };
}
//# sourceMappingURL=replay.js.map