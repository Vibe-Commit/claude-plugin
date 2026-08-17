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
 * ## ⛔ THE SESSION GATE IS WHAT KEEPS THE HUMAN'S COMMITS OUT
 *
 * `post-commit` fires for EVERY commit in the work tree, including ones a human
 * typed with no agent involved. Attributing those would link a commit its author
 * never asked us to see, permanently. So a line is written only when a capture
 * session is demonstrably live for that repo — see `activeSessionFor`.
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
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
 * Which session, if any, is live for this repo right now.
 *
 * ⛔ **THIS IS THE GATE BETWEEN A CAPTURE AND SOMEONE ELSE'S COMMIT.**
 * `post-commit` knows the repository — it is running inside it — but it has no
 * `session_id`: that only ever arrives on the Claude Code hook's stdin. So the
 * session is discovered from the state the hook itself writes, and if no session
 * is live the answer is `null` and nothing is spooled.
 *
 * The most recently touched state file wins. Two concurrent Claude Code sessions
 * in ONE clone are genuinely ambiguous — nothing in a `post-commit` can tell
 * which agent typed the commit — and the most recent one is the best available
 * answer rather than a correct one. ⚠ Stated because it is a real limit of the
 * design, not an oversight.
 *
 * ⚠ **A commit made before a session's FIRST hook has fired is NOT captured**,
 * because the state file it would key on does not exist yet. That is the
 * fail-closed direction and it costs at most the first commit of a session.
 */
export function activeSessionFor(home, repoKey, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return null;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        // No directory at all: nothing has ever captured this repo.
        return null;
    }
    let best = null;
    for (const entry of entries) {
        // ⚠ State files only. `.spool.jsonl` lives here too and is not a session.
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
        if (best === null || touchedAt > best.at) {
            best = { sessionId: entry.slice(0, -".json".length), at: touchedAt };
        }
    }
    return best === null ? null : best.sessionId;
}
/**
 * The SHAs this hook will carry, and how many to drop after a 2xx.
 *
 * ⛔ **FULL WIDTH, ALWAYS.** `capture_commits.commit_sha` is 7..40 because the
 * server's `expandShortSha` can fail, so an abbreviated sha makes the web join
 * SILENTLY EMPTY — a wrong answer with no error, D98's class exactly. Anything
 * that is not a full sha is dropped here rather than sent.
 */
export function capSpool(entries) {
    const taken = entries.slice(0, MAX_SPOOLED_SHAS);
    return { shas: taken.map((e) => e.sha), count: taken.length };
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
    if (typeof sha !== "string" || !/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha))
        return null;
    const at = typeof o.at === "string" ? o.at : "";
    const branch = typeof o.branch === "string" && o.branch !== "" ? o.branch : null;
    const files = Array.isArray(o.files) ? o.files.filter((f) => typeof f === "string") : [];
    return { sha, branch, at, files };
}
//# sourceMappingURL=spool.js.map