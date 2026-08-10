/**
 * The `~/.vibecommit/` layout.
 *
 * One module so the fifteen tasks that build on this one do not each invent a
 * path. Every function takes `home` explicitly rather than calling `os.homedir()`
 * internally — the contract test runs the real binary against a temp HOME, and a
 * module that reads the real one cannot be tested without touching the
 * developer's own credentials.
 *
 * `CR-017d` added the repo to the binding key and hangs per-repo send state off
 * `stateDir` — see `sessionStatePath` and `SessionKey` below.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
/** Root of the client's own state. Never Claude Code's — see the plan's keychain note. */
export function rootDir(home) {
    return join(home, ".vibecommit");
}
/** The ingest credential envelope. Mode 0600, enforced on read (`credential.ts`). */
export function credentialsPath(home) {
    return join(rootDir(home), "credentials.json");
}
/** The per-project consent allow list. Consulted BEFORE any transcript read (D56 §D19). */
export function projectsPath(home) {
    return join(rootDir(home), "projects.json");
}
/**
 * Client state. `CR-023`'s capture-confirmed key lives here under `(repo, day)`;
 * the three negative `systemMessage` states use a per-session file.
 */
export function stateDir(home) {
    return join(rootDir(home), "state");
}
/**
 * Once-per-session marker for a `systemMessage` state.
 *
 * Keyed on `(session, state)` and NOT on the transcript file: `ER23` keys client
 * state per file, which would fire the same message once for `main` and once for
 * every `subagents/agent-*.jsonl` in the same session.
 */
export function sessionNoticePath(home, sessionId, state) {
    return join(stateDir(home), "notices", sanitise(sessionId), `${sanitise(state)}.json`);
}
/**
 * Once-per-`(repo, day)` marker for the capture-confirmed notice — `CR-023d`.
 *
 * **The key is neither the session nor "ever", and both alternatives are wrong
 * in a way you can feel.** `PreCompact` mints a fresh `session_id` mid-task, so
 * a per-session key fires the one positive message twice in an afternoon and
 * reads as a bug. A key with no day component fires it exactly once ever, which
 * under-communicates on a tool used daily — and this is the single positive beat
 * in a channel that is otherwise silent by design (style guide §10.1).
 *
 * A per-FILE key would be wrong too, once `CR-124` (W6) starts producing
 * `agent-*` file keys: it would fire once for `main` and once per sub-agent
 * transcript in the same session. The key is deliberately chosen so that landing
 * `CR-124` cannot change how often this message appears.
 *
 * `repo-day/` namespaces this away from `sessionNoticePath`'s
 * `notices/<session>/<state>.json`: the two live at different depths under
 * `notices/`, so no session id can ever resolve onto a repo-day file.
 *
 * The repo is the same SHA-256 digest `sessionStatePath` uses, for the same
 * reason — `sanitise` truncates at 128 characters, so two deep checkouts sharing
 * a prefix would land on one key and the second repo would never see its
 * confirmation. `day` is supplied by the caller as a UTC `YYYY-MM-DD`
 * (`system_message.ts`'s `utcDay`), never read from a local clock here.
 */
export function repoDayNoticePath(home, repoKey, day, state) {
    return join(stateDir(home), "notices", "repo-day", repoDigest(repoKey), sanitise(day), `${sanitise(state)}.json`);
}
/**
 * Per-`(repo, session)` send state — `CR-018`'s offset ledger, backlog and
 * terminal stop, keyed by `CR-017d`.
 *
 * **Returns null when there is no repo identity, and that is the fix.** D58: *"The
 * server key gains repo; the client offset state did not, so a `prefix_sha256`
 * resync would duplicate repo 1's turns into repo 2."* Keyed on the session alone
 * this file was machine-wide, so one Claude Code session whose `cwd` moved between
 * two repos read and wrote the same offsets for both. A caller with no repo must
 * therefore get NO path at all rather than a shared bucket — a placeholder key is
 * the bleed with an extra step (D72's "required from day one", mirrored).
 *
 * The repo is a SHA-256 digest and not the sanitised path: `sanitise` truncates at
 * 128 characters, and two work trees sharing a long prefix would land in one
 * directory — a silent collision at exactly the boundary being defended.
 *
 * Still one file per session rather than one per `(session, file)`, because `seq`
 * is monotonic per SESSION across the main transcript and every sub-agent's, so
 * splitting the store would split the counter that has to stay single.
 */
export function sessionStatePath(home, key) {
    if (key.repoKey === "")
        return null;
    return join(stateDir(home), "sessions", repoDigest(key.repoKey), `${sanitise(key.sessionId)}.json`);
}
/** A fixed-length, collision-free filename component for a work-tree path. */
function repoDigest(repoKey) {
    return createHash("sha256").update(repoKey).digest("hex").slice(0, 32);
}
/**
 * Where Claude Code writes transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because Claude Code honours it; hard-coding
 * `~/.claude` would silently capture nothing for anyone who relocated it.
 */
export function transcriptRoot(home, env) {
    const configured = env.CLAUDE_CONFIG_DIR;
    const root = configured !== undefined && configured.trim() !== ""
        ? configured.trim()
        : join(home, ".claude");
    return join(root, "projects");
}
/**
 * Is `candidate` really inside `root`?
 *
 * `/cso` finding 1 (2026-08-09), HIGH. `transcript_path` arrives on hook stdin
 * and was read and uploaded verbatim under the user's ingest credential, with no
 * check that it was a transcript at all. Anything that could put a hook
 * definition in front of Claude Code could therefore point the client at
 * `~/.ssh/id_rsa` and have it shipped off the machine — and the hook contract's
 * exit-0 silence meant nothing would show on any stream. The silence that makes
 * the hook safe for the developer's turn is what made that quiet.
 *
 * `realpathSync` on BOTH sides, so a symlink cannot walk out of the root: a
 * string prefix test on the unresolved path is exactly the check that misses
 * `~/.claude/projects/x -> /etc`. A missing path resolves to "outside", because
 * a transcript we cannot resolve is not one we should read.
 */
export function isInside(root, candidate) {
    let realRoot;
    let realCandidate;
    try {
        realRoot = realpathSync(root);
        realCandidate = realpathSync(candidate);
    }
    catch {
        return false;
    }
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}
/**
 * Reduce an untrusted id to a filename component.
 *
 * `session_id` arrives on hook stdin and is attacker-influenced in the sense that
 * matters here: it reaches `path.join`. Whitelisting is the only safe direction —
 * a blacklist of `..` and `/` misses NUL, backslash on Windows, and the empty
 * string, each of which resolves somewhere other than intended.
 */
function sanitise(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
    return cleaned === "" || /^\.+$/.test(cleaned) ? "_" : cleaned;
}
//# sourceMappingURL=paths.js.map