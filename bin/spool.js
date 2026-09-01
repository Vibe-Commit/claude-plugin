/**
 * The commit spool — where `post-commit` leaves what it OBSERVED, for the next
 * Claude Code hook to deliver (`CR-170`, D154).
 *
 * ## Why a spool at all, rather than sending from `post-commit`
 *
 * `post-commit` runs inside `git commit`. A network call there would put our
 * latency on the user's own commit, and a failure would surface as noise in a
 * command that has nothing to do with us. So the commit hook does the one thing
 * only it can do — witness the commit — and writes a line. Delivery stays on the
 * hook path that already has a credential, a budget and a retry story.
 *
 * ## ⛔ APPEND, THEN TRUNCATE ON 2xx — NEVER READ-AND-DELETE
 *
 * A send that fails must leave the commit in the spool so the NEXT hook retries
 * it. Deleting on read would lose a commit to a single 500, permanently, and
 * `capture_commits` rows cannot be retracted (D105/D108). So the truncation is
 * the LAST step and it is conditional on the server's 2xx.
 *
 * ## ⛔ THE SESSION GATE IS ABOUT WHICH SESSION, NOT ABOUT WHO TYPED IT
 *
 * ⚠ **This block used to say the gate is what keeps a HUMAN'S commits out. That
 * has been FALSE since `CR-170` shipped** — `activeSessionFor` has never
 * inspected authorship, and `post_commit.ts` says three lines below its own copy
 * of the claim that the hook *"fires for every commit in this work tree,
 * including ones no agent was involved in."* Corrected as a comment fix; no
 * behaviour moved with it (`D5`).
 *
 * What the gate actually asks is whether a capture session is demonstrably live
 * for this repo, and — since the ladder below — **WHICH ONE**. A line is written
 * only when that question has an answer, and the answer carries the rung that
 * produced it so the server can tell an observation from a guess.
 *
 * ## The line is deliberately small, and the file list stays here
 *
 * `{sha, branch, at, files}`. Only the SHA reaches the wire in wave 1 (`CR-170`
 * §4): commit messages were MEASURED at 9/20, 8/20 and 5/20 commits over 4096
 * bytes across the three repos, largest 12,112, so a quarter of real commits
 * would land permanently truncated in a header. Metadata is backfillable from
 * the sha; the observation is not. `files` is carried for wave 2 and never put
 * in a header.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoSessionsDir, sessionStatePath } from "./paths.js";
/**
 * How many SHAs one hook may put on the wire.
 *
 * A header has a practical size bound and the server pins its own; 40 hex plus a
 * separator is 41 bytes, so 32 is ~1.3 KB and comfortably inside any of them.
 * ⛔ **The rest stay spooled** rather than being dropped — a burst of commits is
 * delivered across several hooks, and hooks are frequent.
 */
export const MAX_SPOOLED_SHAS = 32;
/**
 * A session is "live" for this repo if its state file was touched inside this
 * window.
 *
 * ⚠ **A JUDGEMENT CALL, AND IT IS THE ONE KNOB IN THIS MODULE.** The Claude Code
 * hook writes session state on every fire, so during active work this file is
 * touched every turn. Too short and a long turn's commit is missed; too long and
 * a human's commit hours later is attributed to a session that is morally over.
 *
 * The asymmetry decides it, the same way it did in `spawn_budget.ts`: a MISSED
 * commit is recoverable — the sha is still in git and wave 2 can backfill it —
 * while a WRONGLY ATTRIBUTED commit is a permanent row linking work to a session
 * that did not do it. So this is sized to the length of a plausible single turn,
 * not to the length of a working day.
 */
export const SESSION_LIVE_WINDOW_MS = 30 * 60 * 1000;
/**
 * `<repo>/<session>.spool.jsonl`, beside the session's state file.
 *
 * ⚠ **`.jsonl`, NOT `.json`, and that is load-bearing.** `lastSendForRepo`
 * scans this same directory and filters on `entry.endsWith(".json")`; a spool
 * named `.json` would be parsed as session state, fail, and silently degrade
 * every `vibecommit status` for the repo. Checked rather than assumed — there is
 * a test for exactly that.
 *
 * Null on no repo identity, for the reason `sessionStatePath` is: there is no
 * repo-less bucket and a placeholder key is a cross-repo bleed with an extra step.
 */
export function spoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".spool.jsonl");
}
/**
 * Append one observed commit. Returns false on any failure.
 *
 * ⛔ **NEVER THROWS.** This runs inside `git commit`: an exception here would
 * surface as a failed hook on the user's own commit, which is exactly the noise
 * `post-commit` must not create. A dropped line is strictly better.
 *
 * `appendFileSync` with `a` is a single positioned write, so two commits racing
 * in one repo interleave whole lines rather than corrupting each other.
 */
export function appendSpool(home, key, entry) {
    const path = spoolPath(home, key);
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Every well-formed entry in the spool, oldest first.
 *
 * A malformed line is SKIPPED rather than fatal: the file is appended to by a
 * different process than reads it, so a torn final line is a real possibility
 * and losing one observation beats losing the whole spool.
 */
export function readSpool(home, key) {
    const path = spoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        const entry = parseEntry(line);
        if (entry !== null)
            out.push(entry);
    }
    return out;
}
/**
 * Drop the first `count` entries — called ONLY after the server's 2xx.
 *
 * ⚠ **RE-READS BEFORE REWRITING, and that is not defensive tidiness.**
 * `post-commit` may have appended while the send was in flight. Slicing the
 * array we read BEFORE the send would rewrite the file without those lines and
 * lose them silently. Appends only ever go to the END, so the first `count`
 * lines are still the same ones we delivered, and dropping exactly that many is
 * correct against the current file rather than against a stale snapshot.
 *
 * ⚠ **A residual race remains and is accepted:** a commit landing between this
 * re-read and the write is lost. The window is one `readFileSync` plus one
 * `writeFileSync` on a small file, the cost is one un-delivered commit row, and
 * closing it properly means a lock file on a path that must never block
 * (`post-commit` runs inside the user's `git commit`). Recorded rather than
 * hidden.
 */
export function dropSpooled(home, key, count) {
    const path = spoolPath(home, key);
    if (path === null || count <= 0)
        return false;
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        writeFileSync(path, lines.slice(count).map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Which session, if any, is live for this repo right now — ⛔ **AND HOW WE KNOW.**
 *
 * ## The defect this replaces
 *
 * Until the ladder, this function returned *the most recently mtime'd state file
 * within 30 minutes* and said nothing about its own confidence. Two agents in one
 * clone: session A commits, B's state file is newer, **A's commit enters B's
 * spool** — and `cr071:157` makes the resulting edge PERMANENT, with UPDATE and
 * DELETE both raising for `service_role` too. A wrong edge is forever, so the
 * guess had to stop being indistinguishable from the answer.
 *
 * ## The ladder
 *
 * ```
 *  env id names a live session ─────────> env_session_id         WRITE
 *  no live session at all ──────────────> null                   REFUSE (no row)
 *  env id names NONE of them ───────────> env_session_unmatched  REFUSE (named)
 *  exactly ONE candidate ───────────────> sole_live_session      WRITE  (D5)
 *  TWO OR MORE candidates ──────────────> recency_heuristic      HOLD
 * ```
 *
 * ⛔ **`sole_live_session` ALWAYS WRITES, and that is not a change.** It never
 * inspected authorship and does not start now: a human's `git commit` in a clone
 * with one live session produces a spool line today, at HEAD, and
 * `test/post-commit-spool.test.ts` has a green arm asserting exactly that. What
 * is new is that the server will write a PERMANENT row off this rung, so the rung
 * has to be named on the wire (`D190`).
 *
 * ## ⛔ `env_session_unmatched` — THE THIRD ARM, AND IT IS A REFUSAL WITH A NAME
 *
 * An env id that names **none** of the live candidates is a shape the plan's
 * ladder does not draw, and the code must answer it. It is REAL rather than
 * hypothetical: `agents/registry.ts:11-13` rejects an environment variable as the
 * agent selector precisely because **Codex exports `CLAUDE_PLUGIN_ROOT` itself**,
 * so a Codex agent running under an outer Claude session carries a
 * `CLAUDE_CODE_SESSION_ID` that corroborates nothing here.
 *
 *   - ⛔ `sole_live_session` there would name a session we have POSITIVE evidence
 *     did not commit — the permanent wrong edge, arrived at from the other
 *     direction. Never.
 *   - ⛔ `recency_heuristic` is what this ladder used first, and it is wrong for
 *     the reason `AttributionRung` records: cardinality one, refused **23514**,
 *     and a doubt we do not actually have.
 *   - ⛔ **A silent refusal is worse than either in one respect** — nobody can
 *     afterwards ask *why did that commit vanish*. That is the failure class this
 *     whole wave exists to close, so the refusal is RECORDED and NAMED.
 *
 * ⚠ **The line goes in the recency winner's spool bucket, because that is the
 * only bucket that exists** — an uncorroborated env id deliberately does not open
 * one of its own. The bucket is a FILE LOCATION and the rung is the attribution:
 * the line says, in terms, *this commit is attributed to nobody, and here is
 * why*. It never reaches `x-commits` and never becomes a `commit_attributions`
 * row.
 *
 * ⚠ **So `recency_heuristic` is reachable ONLY with two or more candidates**,
 * which is what `commit_attributions_ambiguity_is_plural` demands. That is a
 * property of the ladder's SHAPE now rather than of a caller's care, and
 * `test/post-commit-spool.test.ts` asserts it directly.
 *
 * ⚠ **A commit made before a session's FIRST hook has fired is still NOT
 * captured**, because the state file it would key on does not exist yet. The env
 * id could key a bucket that has no state file, and deliberately does not: the
 * ladder's first rung requires CORROBORATION, so a stale or inherited variable
 * cannot open a spool of its own.
 *
 * `envSessionId` is a PARAMETER rather than a read of `process.env` here, and it
 * has no default: the compiler is the only thing that will notice a caller which
 * forgot the env path, and this seam has no other check.
 */
export function activeSessionFor(home, repoKey, envSessionId, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const live = liveSessions(home, repoKey, nowMs, windowMs);
    // Rung 1 — the committing process told us, and a state file agrees.
    if (envSessionId !== null && live.some((s) => s.sessionId === envSessionId)) {
        return { sessionId: envSessionId, attribution: "env_session_id" };
    }
    // ⛔ **THE COLD CASE — `CR-195`/D208, and it used to DROP THE COMMIT SILENTLY.**
    //
    // No state file is live for this repo. Until D208 that returned `null` and the
    // observation was gone: MEASURED in a real session as commit `f1608bc`, spooled
    // nowhere. And it is not an edge case — `Stop` fires at the END of a turn, so
    // **every commit made during a session's first turn lands here**, which is
    // exactly what a tester does before asking `blame_commit`.
    //
    // ⚠ **Rung 1 cannot cover it, structurally.** That rung requires
    // `live.some(s => s.sessionId === envSessionId)` — a state file must
    // corroborate the environment — and on the first turn none can exist.
    //
    // So when the committing process DID name itself, record the observation at a
    // rung that says exactly that and cannot mint an edge. When it did not, there
    // is genuinely nothing to record and the silence stands.
    if (live.length === 0) {
        // ⛔ **ONLY FOR A SESSION THAT HAS NO STATE FILE AT ALL, NEVER A STALE ONE.**
        // `activeSessionFor(…, SESSION, +9h)` must stay `null`, and the reason is
        // pinned by a cell: *"an id naming a session that went quiet nine hours ago
        // is still nothing — otherwise a shell that exported the value once would
        // keep a session alive for as long as the terminal lived."* That hazard is
        // real and this rung would have re-opened it, because state files are never
        // deleted: a lingering variable would file every future commit under one
        // ancient session, and promotion would then mint permanent edges for it.
        //
        // ⚠ The distinction is exactly the case this rung is for: a session on its
        // FIRST turn has written nothing yet, while a dead one left a file behind.
        // ⚠ Absence of the file is the line between too EARLY and too LATE. (Worded
        // to avoid `from` followed by a quoted string: `provenance.test.ts` walls
        // RAW TEXT and reads that shape as an escaping import specifier. Third time
        // this guard has fired on ordinary prose in this package; the house response
        // is to move the wording and leave the guard alone.)
        if (envSessionId === null)
            return null;
        const state = sessionStatePath(home, { repoKey, sessionId: envSessionId });
        if (state === null || existsSync(state))
            return null;
        return { sessionId: envSessionId, attribution: "env_session_uncorroborated" };
    }
    // ⛔ THE NAMED REFUSAL, AND IT COMES BEFORE BOTH WRITE RUNGS. We were TOLD who
    // committed, and it is none of these. Falling through would attribute the
    // commit to a session we have positive evidence did not make it.
    if (envSessionId !== null) {
        return { sessionId: live[0].sessionId, attribution: "env_session_unmatched" };
    }
    // Rung 2 — D5. One session, nothing contradicting it.
    if (live.length === 1) {
        return { sessionId: live[0].sessionId, attribution: "sole_live_session" };
    }
    // ⛔ Rung 3 — the guess, and TWO OR MORE candidates is now structurally
    // guaranteed here: every path with an env id returned above, and one candidate
    // returned on the line before. `commit_attributions_ambiguity_is_plural`
    // requires exactly that, and a cardinality-one row is refused 23514.
    return { sessionId: live[0].sessionId, attribution: "recency_heuristic" };
}
/** Every session state file touched inside the window, most recent first. */
function liveSessions(home, repoKey, nowMs, windowMs) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        // No directory at all: nothing has ever captured this repo.
        return [];
    }
    const live = [];
    for (const entry of entries) {
        // ⚠ State files only. `.spool.jsonl` and `.rewrites.jsonl` live here too and
        // are not sessions — and neither ends with `.json`, which is the same
        // load-bearing spelling `spoolPath` documents.
        if (!entry.endsWith(".json"))
            continue;
        let touchedAt;
        try {
            touchedAt = statSync(join(dir, entry)).mtimeMs;
        }
        catch {
            continue;
        }
        if (nowMs - touchedAt > windowMs)
            continue;
        live.push({ sessionId: entry.slice(0, -".json".length), at: touchedAt });
    }
    // ⚠ Ties broken by name so the guess is at least DETERMINISTIC. Two state files
    // written in the same millisecond is ordinary on a coarse-grained filesystem,
    // and a rung that picked differently on each read would be unreproducible as
    // well as wrong.
    live.sort((a, b) => (b.at - a.at) || a.sessionId.localeCompare(b.sessionId));
    return live;
}
/**
 * ⛔ **THE TWO RUNGS THAT MAY GO ON `x-commit-attributions` (`D190`).**
 *
 * The server's vocabulary is exactly these two (`edge_derivation.ts:178`) and a
 * rung outside it is **skipped silently** — no edge, no error, no log. So the
 * refusal lives here, on the producing side, rather than being discovered as a
 * zero where edges should have been.
 *
 * ⚠ **This constant is NOT what the wire cell asserts against.** There is no
 * shared type across that seam and inventing one would couple an MIT client to a
 * closed server, so the cell types the literals itself — round-tripping this
 * constant through our own code would only prove it equals itself (`D190 §5`).
 */
export const WIRE_RUNGS = ["env_session_id", "sole_live_session"];
/**
 * The SHAs this hook will carry, their rungs, and how many lines to drop after a
 * 2xx.
 *
 * ⛔ **FULL WIDTH, ALWAYS.** `capture_commits.commit_sha` is 7..40 because the
 * server's `expandShortSha` can fail, so an abbreviated sha makes the web join
 * SILENTLY EMPTY — a wrong answer with no error, D98's class exactly. Anything
 * that is not a full sha is dropped by `parseEntry` rather than sent.
 *
 * ⛔ **`shas` AND `attributions` ARE THE SAME LENGTH BY CONSTRUCTION** — one
 * `push` each, in one iteration, or neither. That is not style.
 * `parseObservedCommits` returns `[]` when the two lists differ in length: **the
 * ENTIRE BATCH is dropped, not the odd entry**, with no edge, no error and no
 * log (`D190 §1`). A `filter` and a `map` over the same array would be the same
 * thing until someone changed one of them.
 *
 * ⛔ **`count` IS LINES CONSUMED, NOT `shas.length`, AND THEY DIVERGE.** A held
 * entry is consumed and never sent. `dropSpooled` drops **the first N lines**, so
 * a caller truncating by `shas.length` would delete a held line at the head and
 * re-send the commit that was actually delivered — forever.
 *
 * ⚠ **A held entry IS dropped on the 2xx, and the observation is lost.** Stated
 * rather than hidden: this wave gives the client no way to transmit a held
 * commit, and leaving it in the file would make every subsequent hook re-read a
 * line that can never be sent. The asymmetry this module already runs on decides
 * it — a MISSED commit is recoverable, the sha is still in git, while a WRONGLY
 * ATTRIBUTED one is a permanent row (`cr071:157`).
 */
export function capSpool(entries) {
    const taken = entries.slice(0, MAX_SPOOLED_SHAS);
    const shas = [];
    const attributions = [];
    for (const entry of taken) {
        if (!WIRE_RUNGS.includes(entry.attribution))
            continue;
        shas.push(entry.sha);
        attributions.push(entry.attribution);
    }
    return { shas, attributions, count: taken.length };
}
/**
 * How many rewrite pairs one hook may put on the wire.
 *
 * ⛔ **ITS OWN CONSTANT, AND SHARING `MAX_SPOOLED_SHAS` WOULD MAKE ONE OF THE TWO
 * WRONG.** The units differ: a sha plus a separator is 41 bytes, a pair plus a
 * separator is **82** (40 + `:` + 40 + `,`). 16 pairs is 1,312 bytes — the same
 * header budget `MAX_SPOOLED_SHAS = 32` was sized against, arrived at through the
 * arithmetic of this header rather than inherited from the other one.
 *
 * ⛔ **The rest stay spooled**, exactly as the commit spool's remainder does.
 */
export const MAX_SPOOLED_PAIRS = 16;
/** `<repo>/<session>.rewrites.jsonl`, beside the commit spool. */
export function rewriteSpoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".rewrites.jsonl");
}
/**
 * Append rewrite pairs, skipping any already spooled. Returns how many were
 * WRITTEN — ⛔ not how many were offered.
 *
 * ## ⛔ THE DEDUP IS ONE OF T4'S TWO GUARDS, AND IT IS NOT REDUNDANCY
 *
 * `M6` measured the squash hazard and it is **SIZE-DEPENDENT**. A 3→1 squash
 * fires `post-rewrite` twice — `amend A→F`, then `rebase A→F; B→F` — so **the
 * pair `A→F` arrives twice**. A 4→1 squash instead produces rows naming an
 * INTERMEDIATE sha that never existed on any branch; that one is killed by the
 * in-progress-rebase suppression in `hooks/post_rewrite.ts`, which cannot see the
 * duplicate, exactly as this cannot see the intermediate. **One squash size
 * cannot test both.**
 *
 * ⚠ **Dedup is against the FILE, not against the batch**, because the two fires
 * are two processes: a batch-local check would see one pair each time and dedup
 * nothing. ⚠ The read-then-append is not atomic — two rewrites racing in one
 * clone could both miss — but `post-rewrite` runs inside git's own serialised
 * rebase, and the cost of the residual race is one duplicate pair rather than a
 * wrong one.
 *
 * ⛔ **NEVER THROWS.** This runs inside the user's `git rebase`.
 */
export function appendRewrites(home, key, pairs) {
    const path = rewriteSpoolPath(home, key);
    if (path === null)
        return 0;
    const seen = new Set(readRewrites(home, key).map(wirePair));
    let written = 0;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        for (const pair of pairs) {
            const wire = wirePair(pair);
            if (seen.has(wire))
                continue;
            seen.add(wire);
            appendFileSync(path, `${JSON.stringify(pair)}\n`, { mode: 0o600 });
            written += 1;
        }
        if (written > 0)
            chmodSync(path, 0o600);
        return written;
    }
    catch {
        return written;
    }
}
/** Every well-formed pair in the rewrite spool, oldest first. */
export function readRewrites(home, key) {
    const path = rewriteSpoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        const pair = parsePair(line);
        if (pair !== null)
            out.push(pair);
    }
    return out;
}
/** Drop the first `count` pairs — called ONLY after the server's 2xx. */
export function dropRewrites(home, key, count) {
    const path = rewriteSpoolPath(home, key);
    if (path === null || count <= 0)
        return false;
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        writeFileSync(path, lines.slice(count).map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The pairs this hook will carry, and how many to drop after a 2xx.
 *
 * ⛔ **`ancestor:successor`, COLON-SEPARATED.** `parseRewritePairs` drops
 * silently on a wrong separator, on a third colon-field, on a bad sha and on a
 * self-pair — no edge, no error, no log (`D190 §1`).
 */
export function capSuccessors(pairs) {
    const taken = pairs.slice(0, MAX_SPOOLED_PAIRS);
    return { pairs: taken.map(wirePair), count: taken.length };
}
/** The wire spelling of one pair. Also the dedup key. */
function wirePair(pair) {
    return `${pair.ancestor}:${pair.successor}`;
}
function parsePair(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const { ancestor, successor } = o;
    // ⛔ Re-validated on the way OUT as well as in. A spool file is on disk and
    // outlives the process that wrote it, so what comes back is input.
    if (!isFullSha(ancestor) || !isFullSha(successor))
        return null;
    // ⚠ A self-pair is dropped by the server anyway; dropping it here keeps a
    // no-op from occupying one of the 16 slots a real pair needs.
    if (ancestor === successor)
        return null;
    return { ancestor, successor };
}
/** Full width, both widths git uses. ⛔ Never abbreviated. */
export function isFullSha(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
}
function parseEntry(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const sha = o.sha;
    // ⛔ The width check lives here as well as at the boundary: a spool file is
    // on disk and outlives the process that wrote it, so what comes back out is
    // input, not something we already validated.
    if (!isFullSha(sha))
        return null;
    const at = typeof o.at === "string" ? o.at : "";
    const branch = typeof o.branch === "string" && o.branch !== "" ? o.branch : null;
    const files = Array.isArray(o.files) ? o.files.filter((f) => typeof f === "string") : [];
    return { sha, branch, at, files, attribution: parseRung(o.attribution) };
}
/**
 * ⛔ **AN UNLABELLED LINE IS `recency_heuristic`, AND THAT IS NOT A DEFAULT — IT
 * IS THE CORRECT NAME FOR HOW IT WAS PRODUCED.**
 *
 * A spool file outlives the process that wrote it and survives an upgrade, so a
 * line written by a PRE-LADDER client is ordinary input here. That client picked
 * its session by mtime recency, with no corroboration and no way to tell one
 * candidate from two. Naming it anything else would upgrade a guess to an
 * observation on the strength of a version number.
 *
 * ⚠ **This is `D190 §2`'s NO RUNG, NO EDGE, on the client side.** The server
 * refuses to write an edge for a commit that arrives without a rung, for exactly
 * this reason; here the same commit is refused a place on `x-commits` before it
 * is ever sent. Both directions of the seam agree, independently.
 */
function parseRung(value) {
    switch (value) {
        case "env_session_id":
        case "sole_live_session":
        case "env_session_unmatched":
            return value;
        default:
            // ⛔ INCLUDING an unlabelled line and a rung outside the vocabulary. A
            // near-miss spelling is NOT admitted: the server skips an unknown rung
            // silently, which is a zero with no error, so it is resolved here to the
            // value that says *we do not know*.
            return "recency_heuristic";
    }
}
// ---------------------------------------------------------------------------
// ⛔ THE PENDING SIDECAR — `CR-195`/D208.
//
// A THIRD file beside `.spool.jsonl` and `.rewrites.jsonl`, for the same reason
// the second one exists: the two are read by different code at different times,
// and a discriminator inside one file would make a torn line of one kind cost
// the other kind too.
//
// ⛔ **WHY NOT JUST LEAVE THE LINE IN `.spool.jsonl`.** `capSpool` returns
// `count: taken.length` — every line taken, wire-eligible or not — and
// `dropSpooled` truncates by that count on the 2xx, so a non-wire line is
// DISCARDED by the next successful post (`spool.ts`'s own note: *"A held entry
// IS dropped on the 2xx, and the observation is lost"*). An uncorroborated line
// left there would be destroyed by the very post that could not carry it, and
// "binds when a state file appears" could never happen.
//
// ⚠ And the truncation rule it would have to change is load-bearing: `count`
// rather than `shas.length` exists precisely so a retained line at the head
// cannot shift every subsequent index and re-send a delivered commit forever.
// A separate file gives this rung different retention while leaving that
// invariant byte-untouched.
//
// ⚠ `.pending.jsonl` — like its two siblings it must NOT end in `.json`, or
// `lastSendForRepo` parses it as session state and `liveSessions` counts it as a
// live session, which would make an uncorroborated commit corroborate itself.
// ---------------------------------------------------------------------------
/**
 * How many uncorroborated commits one session may hold.
 *
 * ⛔ **ITS OWN CONSTANT** — the house rule `MAX_SPOOLED_PAIRS` states: sharing a
 * bound across two files with different units makes one of them wrong. This one
 * is not a header budget at all, because nothing here reaches a header; it is a
 * bound on how much unpromotable observation may accumulate before the oldest is
 * dropped. Sized under `MAX_SPOOLED_SHAS` deliberately: a session that made 32
 * commits before its first `Stop` is not a session, and the failure direction of
 * being too small is a MISSED commit, which the module's own asymmetry prefers
 * to a wrong one.
 */
export const MAX_PENDING_SHAS = 16;
/** `<repo>/<session>.pending.jsonl`, beside the commit spool. */
export function pendingSpoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".pending.jsonl");
}
/**
 * Record an uncorroborated observation. Returns whether it was written.
 *
 * ⚠ Deduped on sha, like `appendRewrites`: `post-commit` can fire twice for one
 * commit (a manual invocation beside the real hook), and two lines for one sha
 * would promote into two spool entries and two permanent rows —
 * `capture_commits`' PK is `(org_id, capture_id, commit_sha)`, so two capture
 * ids are two legal rows for one commit.
 */
export function appendPending(home, key, entry) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        const existing = readPending(home, key);
        if (existing.some((e) => e.sha === entry.sha))
            return false;
        const kept = [...existing, entry].slice(-MAX_PENDING_SHAS);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, kept.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** Every uncorroborated entry for this session, oldest first. */
export function readPending(home, key) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        const entry = parseEntry(line);
        if (entry !== null)
            out.push(entry);
    }
    return out;
}
/** Remove the pending file entirely. Used once its lines have been promoted. */
export function clearPending(home, key) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        rmSync(path, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * ⛔ **PROMOTION — the half that makes the cold rung worth recording.**
 *
 * A pending line names the session the committing process reported. Once THAT
 * session has a state file, the environment's claim is corroborated by exactly
 * the evidence rung 1 requires, so the line is rewritten into the real spool as
 * `env_session_id` and the pending file is cleared.
 *
 * ⚠ **The corroboration is the session's OWN state file, not any state file.**
 * Promoting on "some session is live" would be `sole_live_session` wearing a
 * stronger rung's name — the environment said WHO, and the whole value of rung 1
 * over rung 2 is that it is a fact about the committing process rather than
 * about there being nobody else it could have been (D5).
 *
 * Returns how many were promoted. Safe to call when there is nothing to do.
 */
export function promotePending(home, key, 
/**
 * ⛔ **THE CORROBORATION, AND IT IS A LITERAL TYPE ON PURPOSE** — the same
 * device `TranscriptDialect.transport` uses. It cannot be satisfied by
 * accident: a caller must type the claim, and the claim is that `key.sessionId`
 * is the session whose hook is executing right now.
 *
 * ⚠ **A STATE FILE IS THE WRONG TEST AND I TRIED IT FIRST.** State files are
 * never deleted, so `existsSync` promotes months later against a session that
 * ended long ago; and gating on the 30-minute window instead FAILS THE ONLY
 * CASE THIS RUNG EXISTS FOR — on a session's first `Stop` the state file has
 * not been written yet (`deliver` saves it, after this runs), so nothing would
 * ever promote on the turn that matters. MEASURED: the cold-start commit sat
 * unpromoted with the delta carrying no commits.
 *
 * ⛔ Running the hook is STRONGER evidence than either: a state file proves a
 * session ran once, an executing hook proves it is running NOW. And it closes
 * the resurrect hazard by construction — a dead session never runs a hook, so
 * a lingering exported `CLAUDE_CODE_SESSION_ID` accumulates pending lines that
 * are never promoted and age out under `MAX_PENDING_SHAS`.
 */
corroboration) {
    void corroboration;
    const pending = readPending(home, key);
    if (pending.length === 0)
        return 0;
    let promoted = 0;
    for (const entry of pending) {
        if (appendSpool(home, key, { ...entry, attribution: "env_session_id" }))
            promoted += 1;
    }
    clearPending(home, key);
    return promoted;
}
//# sourceMappingURL=spool.js.map