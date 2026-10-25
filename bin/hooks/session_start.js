/**
 * `SessionStart` — the event that never uploads (0.7.0, eng review D3 · A, D4 · A, A4).
 *
 * It does three things in a clone that is already captured, and nothing else:
 *
 *   1. installs the clone's two git hooks, once, and ONLY when that is a plain write;
 *   2. says so, once, as the hook's one `systemMessage` (style guide §10.1 states 6-8);
 *   3. says the other things a session start can know without sending anything: the machine has no
 *      credential (state 1), the credential ends soon (state 5), `grants.json` is unreadable (state 9).
 *
 * ⛔ **IT NEVER READS `transcript_path` AND NEVER SENDS.** `entry.ts` resolves the canonical event first and
 * branches here BEFORE the consent gate and before the transcript confinement check, so this module is not a
 * path a transcript can reach. There is no `fetch` here and nothing it imports makes a request; the cells in
 * `test/session-start.test.ts` assert 0 requests and an unopened transcript for each of the three dialects.
 *
 * ⚠ **The consent gate is still applied — HERE**, because installing git hooks into a repo is a write into
 * the user's clone and "absence means no" covers writes as much as reads. An ungranted or excluded clone gets
 * silence and no file.
 *
 * ## The budget
 *
 * SessionStart runs on each agent's STOP clocks, with no fast path of its own (eng review D7 · B, Alexander's
 * choice over a 1.5 s cap). That is a logged shortcut — gstack-shortcut(dec-e650afbf) — and the constants carry
 * the marker in `src/agents/*.ts`. The ceiling: a hung git call here can hold a session's start up by as long
 * as the agent's REGISTERED timeout. `startSpawnBudget` (armed in `runHook`) still bounds every spawn.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantsUnreadable, isCaptureAllowed, isLocalSlug } from "../consent.js";
import { endingSoon, metaFor } from "../credential_meta.js";
import { loadCredential } from "../credential.js";
import { onceRepoSlug } from "../git.js";
import { installChannel, installCaptureHooks } from "../install.js";
import { cloneMarkerPath } from "../paths.js";
import { credentialFingerprint } from "../post.js";
import { resolveProjectKeys } from "../project.js";
/** The file in the git COMMON dir that names this clone. Shared by every linked worktree; `gc` never touches it. */
// ⚠ Not `vibecommit-…`: `test/provenance.test.ts` reads every `vibecommit-<word>` token in src/ as a sibling repository
// that must be declared, so a filename of that shape fails it. The name is a plain one for that reason alone.
const CLONE_ID_FILE = "capture-clone-id";
/**
 * This clone's identity for the once-per-clone markers: a random nonce in `<common-dir>/capture-clone-id`,
 * written once, on the first install in a granted clone (eng review D4 · A, VQ's ruling on PR 4's P1).
 *
 * ⛔ **WHY A NONCE AND NOT SOMETHING DERIVED FROM GIT.** The first version keyed on the common dir plus the oldest
 * HEAD reflog entry, and that key MOVES: a linked worktree has its own HEAD reflog, `git gc` expires old entries
 * (reachable ones after 90 days, unreachable after 30), and a reflog past about 18k entries overflows the spawn's
 * 1 MiB buffer. Each gave a new key, so a deleted hook was written back — the one thing D4 forbids. A file in the
 * common dir has none of those failure modes: worktrees share it, `gc` leaves it alone, and a fresh clone at the
 * same path has no `.git` of the old one, so it has no id and installs again — D4's three properties, kept.
 *
 * Returns null when the id can be neither read nor made (a read-only `.git`): no key means no install, which is the
 * safe direction. `wx` makes the first writer win; a racing second session reads the winner's value.
 */
export function cloneId(commonDir) {
    const path = join(commonDir, CLONE_ID_FILE);
    const read = () => {
        try {
            const text = readFileSync(path, "utf8").trim();
            return /^[0-9a-f]{32}$/.test(text) ? text : null;
        }
        catch {
            return null;
        }
    };
    const existing = read();
    if (existing !== null)
        return existing;
    try {
        writeFileSync(path, `${randomBytes(16).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    }
    catch {
        // Lost the race (EEXIST) or cannot write; either way the file, if there is one, is the answer.
    }
    return read();
}
/** The install record: `clone/<digest>/installed.json`, beside the notice markers. */
function installRecordPath(home, key) {
    return cloneMarkerPath(home, key, "installed");
}
/** What the install record says. `wrote` is whether THIS client put a hook there, which is what owes the clone state 6. */
function readInstallRecord(home, key) {
    try {
        const parsed = JSON.parse(readFileSync(installRecordPath(home, key), "utf8"));
        return { wrote: parsed.wrote === true };
    }
    catch {
        return null;
    }
}
/** Best effort; a record we cannot write means the next session tries again, which is the safe direction. */
function writeInstallRecord(home, key, wrote) {
    try {
        const path = installRecordPath(home, key);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), wrote })}\n`, { flag: "wx", mode: 0o600 });
    }
    catch {
        // An existing record (`wx`) or an unwritable home: both leave the clone as it was.
    }
}
/**
 * Install this clone's git hooks if, and only if, it is the first time and the write is a plain one.
 *
 * Returns the notice STATE to speak (6, 7 or 8), or null for "nothing to say" — which includes a clone that
 * already had an install record (D4: a hook the user deleted stays deleted; `vibecommit connect` puts it back
 * with the user watching), one whose slots were already ours, and a write that failed.
 *
 * ⭐ **STATE 6 IS OWED UNTIL IT HAS BEEN SAID.** The install record says the hooks were written; whether the
 * notice was SAID is its own once-per-clone claim. So a clone installed in a session where state 1 or 5 outranked
 * 6, or installed by Cursor's `sessionStart` (which says nothing), still owes state 6, and the next hook that can
 * speak says it — until `renderNotice` has claimed it, after which it is never owed again.
 *
 * What is recorded, and what is not: an install, and a clone whose slots were already ours, write the record. A
 * `core.hooksPath` redirect and a foreign hook write no hook and no install record — the clone id IS written (it
 * is a consented repo, and the markers for states 7 and 8 are keyed by it), so those states stay once per clone —
 * and a later session re-probes, cheaply and silently. A `failed` write is retried next session for the same
 * reason.
 */
export function installOnce(ctx, keys) {
    // No binary path to point a git hook at, or the plugin channel — which installs no git hooks, by contract
    // ("the plugin installs no git hooks" stays true; TODOS [173] (a2) is Alexander's call).
    if (ctx.selfPath === "" || installChannel(ctx.env, ctx.selfPath).kind === "plugin") {
        return { state: null, cloneKey: "" };
    }
    const key = cloneId(keys.consent);
    if (key === null)
        return { state: null, cloneKey: "" };
    const record = readInstallRecord(ctx.home, key);
    if (record !== null) {
        const owed = record.wrote && !existsSync(cloneMarkerPath(ctx.home, key, "hooks_added"));
        return { state: owed ? "hooks_added" : null, cloneKey: key };
    }
    const result = installCaptureHooks(keys.worktree, ctx.selfPath, { plainWriteOnly: true });
    const kinds = [result.commit.kind, result.rewrite.kind];
    if (kinds.includes("hooks-path"))
        return { state: "hooks_path_set", cloneKey: key };
    if (kinds.includes("foreign"))
        return { state: "own_commit_hook", cloneKey: key };
    if (kinds.includes("failed"))
        return { state: null, cloneKey: key };
    const wrote = (v) => v.kind === "installed" || v.kind === "chained";
    const didWrite = wrote(result.commit) || wrote(result.rewrite);
    writeInstallRecord(ctx.home, key, didWrite);
    return { state: didWrite ? "hooks_added" : null, cloneKey: key };
}
/**
 * The `SessionStart` hook body. Returns the stdout payload or null; never throws past the caller's catch, and
 * opens no transcript.
 *
 * Precedence — one hook speaks at most once: 9, then 1, then 5, then 7, 8, 6. (States 2 and 4 need a send, and
 * 3 is `hookBody`'s own check ahead of the branch, so on a runtime below the Node floor 3 outranks 9: nothing
 * else on such a runtime works either.) A state that is already claimed returns null and the next one speaks.
 */
export function sessionStartPayload(ctx) {
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null)
        return null;
    const slugOf = onceRepoSlug(keys.worktree);
    // ⛔ CURSOR'S `sessionStart` HAS NO USER-VISIBLE FIELD (Open Question 1, static read), so it installs and says
    // NOTHING: it renders no notice and, because `renderNotice` is what claims, it claims none. Rendering here would
    // print a line nobody sees AND use up the clone's state 6 and the machine's once-a-day 9 and 5, leaving Claude
    // Code and Codex quiet. State 6 stays owed (`installOnce`) for the next hook that can speak — Cursor's first
    // `stop`. Ahead of the state-9 branch for the same reason.
    if (ctx.agentId === "cursor") {
        if (isCaptureAllowed(ctx.home, keys, slugOf))
            installOnce(ctx, keys);
        return null;
    }
    // State 9 first. An unreadable `grants.json` denies every repo with a remote, so the hook can say so once a
    // day per machine — but only from a clone it WOULD have captured, so a folder with no remote hears nothing.
    if (grantsUnreadable(ctx.home) && !isLocalSlug(slugOf())) {
        return ctx.notice("grants_unreadable");
    }
    if (!isCaptureAllowed(ctx.home, keys, slugOf))
        return null;
    // The side effect comes before any notice, so a higher-precedence notice never costs the install — and state 6
    // stays OWED to a later session rather than lost (`installOnce`).
    const installed = installOnce(ctx, keys);
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind !== "ok") {
        const notConnected = ctx.notice("not_connected");
        if (notConnected !== null)
            return notConnected;
    }
    else {
        const endsAt = endingSoon(metaFor(ctx.home, credentialFingerprint(load.credential)), Date.now());
        if (endsAt !== null) {
            const ending = ctx.notice("credential_ending", null, load.credential, endsAt);
            if (ending !== null)
                return ending;
        }
    }
    if (installed.state === null)
        return null;
    return ctx.notice(installed.state, null, undefined, undefined, installed.cloneKey);
}
//# sourceMappingURL=session_start.js.map