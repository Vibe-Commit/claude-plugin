/**
 * The consent gate — D56 plan §D19, D65 §DR7.
 *
 * **It runs BEFORE anything reads `transcript_path`.** That ordering is the whole
 * control: a gate that runs after the read has already read the thing it was
 * gating. `hooks/entry.ts` calls `isProjectAllowed` before it touches the
 * transcript, and `test/consent.test.ts` asserts the transcript file is never
 * opened on the unconsented path.
 *
 * Three rules, in order of how easily they break (style guide §10.2):
 *   1. **The default is `N`.** A consent prompt whose default is yes is not a
 *      consent prompt.
 *   2. **Non-TTY refuses**, with exit 2 (DESIGN.md §13.7). Never proceed.
 *   3. Storage is an allow list keyed on the CONSENT KEY — absence is a NO.
 *      Nothing here can fail open: every error path returns "not allowed".
 *
 * ## ⛔ The key is `resolveProjectKeys(dir).consent`, NOT the git toplevel (D184)
 *
 * A toplevel key differs per `git worktree`, and with no wildcards and
 * absence-means-no that meant an agent session inside a worktree captured
 * **nothing** — silently, by design, because an unconsented repo must not nag.
 * The consent key is the canonicalised git COMMON DIR instead: shared by a main
 * clone and every worktree linked to it, and `M2` shows the post-commit install
 * already had that same reach.
 *
 * ⛔ **This file stays key-agnostic — it stores the string it is given.** The
 * canonicalisation that stops `.git` from being every main clone's key lives in
 * `project.ts` where the value is produced, because a key is only as good as the
 * one place that can mint it. What changes here is the CONTRACT: callers pass
 * `.consent`, and the parameter is named for it so a toplevel passed by habit
 * reads wrong at the call site.
 *
 * ⚠ **No migration for allow lists written under the old key**, and that is a
 * decision rather than an omission: pre-launch there are zero users and zero
 * rows (`project_pre_launch_no_data`), so there is nothing to migrate. See
 * `resolveProjectKeys`.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { projectsPath, rootDir } from "./paths.js";
/**
 * Read the allow list. **Every failure returns an empty list**, which means "no
 * project is consented" — a corrupt or unreadable file must not be able to grant
 * capture on a repo the user never approved.
 */
export function readAllowList(home) {
    let raw;
    try {
        raw = readFileSync(projectsPath(home), "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const at = value.at;
                out[key] = { at: typeof at === "string" ? at : "" };
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
/** Absence is a NO. There is no wildcard and no "all projects" key. */
export function isProjectAllowed(home, consentKey) {
    if (consentKey === null)
        return false;
    return Object.prototype.hasOwnProperty.call(readAllowList(home), consentKey);
}
/** Record consent for one project. 0700 on the directory, 0600 on the file. */
export function grantProject(home, consentKey, now) {
    const path = projectsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    const next = {
        ...readAllowList(home),
        [consentKey]: { at: now.toISOString() },
    };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's `mode` is ignored when the file already exists.
    chmodSync(path, 0o600);
}
/** Revoke consent for one project (`vibecommit off`). */
export function revokeProject(home, consentKey) {
    const current = readAllowList(home);
    if (!Object.prototype.hasOwnProperty.call(current, consentKey))
        return false;
    const next = { ...current };
    delete next[consentKey];
    const path = projectsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
}
/**
 * Interpret an answer to the consent prompt. **Only an explicit yes is a yes.**
 * Empty (the user pressed return) is NO, which is what makes `[y/N]` honest.
 */
export function isAffirmative(answer) {
    const a = answer.trim().toLowerCase();
    return a === "y" || a === "yes";
}
//# sourceMappingURL=consent.js.map