/**
 * What "this repository" means ON THE WIRE — `CR-019d`, the client half of
 * `CR-019`.
 *
 * ⚠ **This is not `project.ts`'s question and the two answers are not
 * interchangeable.** `resolveProjectKey()` answers "which work tree is this?"
 * with a local filesystem path, and that path is the consent key and (since
 * `CR-017d`) half the local state key — it never leaves the machine.
 * `resolveRepoSlug()` answers "which repository is this, in terms the SERVER can
 * resolve?" and its value goes on the wire as `X-Repo-Slug`. Conflating them
 * would put an absolute path from a developer's laptop into a tenant-scoped
 * lookup, so they stay separate functions with separate return shapes.
 *
 * ## The contract this must satisfy, read from the merged server, not inferred
 *
 * `CR-019b` shipped and `X-Repo-Slug` is REQUIRED. `parseIngestHeaders`
 * (`vibecommit-mcp/src/conversation/ingest_session.ts`) rejects an absent header
 * — and a present one that is empty after `.trim()` — with a 400 whose reason is
 * `missing X-Repo-Slug`, and rejects anything over 256 characters. So there is
 * no lenient path to fall back to: this module always returns a non-empty slug
 * for a directory that has a git toplevel at all.
 *
 * D57 §OV1 is why the server is strict: *"A NULL `repository_id` is
 * fail-closed-invisible per `org_access_model.sql`, so without this every hook
 * capture would be hidden from its own author."* `readable_repository_ids` is a
 * POSITIVE list, so a capture with no repository renders to nobody — including
 * the person who just made it. A 400 is strictly better than that silence.
 *
 * ## The two keys have different GRAIN, and that is correct in both directions
 *
 * This is where the local and wire identities line up, so it is where the
 * mismatch between them belongs on the record. A linked `git worktree` has its
 * own toplevel — verified, `rev-parse --show-toplevel` returns the worktree
 * directory, not the main clone — so two worktrees of one repository are two
 * `repoKey`s and therefore two local offset ledgers, while sharing one `origin`
 * makes them one `repoSlug` and one server `repository_id`.
 *
 * Both halves of that are the behaviour you want. Locally, separate ledgers are
 * the safe direction: the state key exists to keep two work trees from applying
 * each other's byte offsets (`CR-017d`, D58), and over-separating costs a resync
 * at worst. On the wire, one identity is simply true — two worktrees of one
 * repository ARE one repository, and minting two would fragment the audit record
 * of a single repo.
 *
 * The one reachable oddity: two worktrees driven by ONE Claude Code session (so,
 * one `session_id`) would keep two independent client ledgers against a single
 * server stream key. The server is idempotent on `(session, offset)` and treats
 * a disagreement as a resync, so the cost is re-sent bytes, never a cross-repo
 * bleed. Not designed around; recorded so the next person meets it as a known
 * property rather than a surprise.
 *
 * ## Case, and why this does not lowercase
 *
 * `resolve_repository` canonicalises with `lower(trim(coalesce(slug, '')))` and
 * the App-installation oracle compares `lower(r.repo_full_name) = v_slug`, so
 * both sides are lowercased and case cannot affect resolution. What case DOES
 * affect is the row the server writes: `display_name` is
 * `trim(p_source_repo_full_name)` — the raw value sent here. Preserving the
 * remote's own case therefore gives a correctly-cased display name for free,
 * and lowercasing would throw that away for no gain.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — parseIngestHeaders, read
 * @provenance vibecommit-schema org_access_model.sql — readable_repository_ids, read
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { spawnTimeoutMs } from "./spawn_budget.js";
/**
 * Per-spawn CEILINGS — the most any one call may take when no hook budget is
 * armed (a CLI verb). ⚠ **A ceiling is not a bound**: four of these on one hook
 * path summed to 20s against a 5s watchdog, which is `TODOS[87]`. What bounds
 * them is `spawnTimeoutMs`, which hands back the SMALLER of the ceiling and what
 * is left of one shared window.
 */
const GIT_TIMEOUT_MS = 5_000;
/** Tighter than the git probes: `ssh -G` is pure config evaluation, measured ~4ms. */
const SSH_TIMEOUT_MS = 2_000;
/**
 * Hosts whose URLs are confidently GitHub.com — and therefore the ONLY hosts
 * that emit an UNQUALIFIED two-segment `owner/repo`.
 *
 * `ssh.github.com` is GitHub's documented port-443 SSH endpoint, used by anyone
 * behind a firewall that blocks 22. It is the same host in every sense that
 * matters here, and dropping those users to `local:` would silently cost them
 * repository attribution for a config GitHub itself tells them to use.
 *
 * ⚠ **THIS SET MUST NOT GROW TO INCLUDE GHES OR ANY OTHER FORGE** (D157). It is
 * not "hosts we support" — it is "hosts whose slug the App-installation oracle
 * can resolve". `resolve_repository` matches the oracle on
 * `github_installation_repos.repo_full_name`, which is `owner/repo`, so a host
 * added here starts claiming the github.com namespace. Every other host is
 * host-qualified instead — see `parseRemoteSlug`.
 */
const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);
/**
 * A hostname we are willing to hand to `ssh` and to put in a slug.
 *
 * ⚠ **THIS IS AN ARGUMENT-INJECTION GUARD, NOT A VALIDATOR.** `execFileSync`
 * closes the shell-injection hole but NOT the option-injection one: a host is
 * attacker-influenced (it comes from `.git/config`, which travels with a clone),
 * and `fromScpLike`'s host group happily matches a leading `-`. Measured:
 * `ssh -G "-oProxyCommand=…"` is parsed as FLAGS and prints ssh's usage. So a
 * host that is not plainly a hostname never reaches `ssh` — and `--` below is
 * the second, independent guard, because two cheap guards on a spawn beat one.
 *
 * No leading or trailing `-` or `.`, and nothing outside the LDH set, which is
 * what a real DNS name is anyway.
 */
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
/**
 * A GitHub account name: alphanumerics and hyphens, no leading or trailing
 * hyphen. Deliberately GitHub's own rule rather than "anything without a
 * slash" — see the confidence note on `resolveRepoSlug`.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A GitHub repository name. `.` and `..` are excluded below, not here. */
const REPO = /^[A-Za-z0-9._-]+$/;
/**
 * `owner/repo` for a work tree whose `origin` is GitHub, `host/owner/repo` for
 * any other host, else `local:<sha256(abspath)[0:12]>`.
 *
 * **Takes the TOPLEVEL, not a `cwd`.** Every caller already has it: the consent
 * gate resolves `resolveProjectKey(input.cwd)` before anything else runs and
 * refuses when it is null, so re-deriving it here would be a second
 * `git rev-parse` spent against the hook's wall-clock budget (DESIGN.md §13.7)
 * to recompute a value the caller is holding — and a second call could disagree
 * with the first, which is the same reason `CR-017d` reuses it for the state key
 * rather than recomputing.
 *
 * **Never returns empty.** A work tree always has an identity: with a remote it
 * is the remote's, without one it is the path's. That is what lets the server
 * require the header (D58 §ER25).
 *
 * ## ⚠ Why `local:` had to stop being the answer for a real remote (D157)
 *
 * `localSlug` hashes the developer's OWN ABSOLUTE PATH. That is correct for a
 * work tree with no remote — there is nothing else to key on, and two such trees
 * genuinely are two repositories. It is WRONG for a tree that has a remote:
 * every colleague, and every second clone on one machine, mints a DIFFERENT
 * repository for what is provably one repo. Captures never join, the graph
 * cannot span them, and **nothing errors** — the failure is silent by
 * construction, which is what made it survive this long.
 *
 * So `local:` now survives only where it is true: **no remote at all**, or a
 * remote whose path is not `owner/repo` and therefore cannot be named without
 * guessing (`parseRemoteSlug` refuses rather than guesses — `CR-019d`).
 */
export function resolveRepoSlug(toplevel) {
    const remote = gitRemoteUrl(toplevel);
    const slug = remote === null ? null : parseRemoteSlug(remote);
    return slug ?? localSlug(toplevel);
}
/**
 * `origin`'s URL, or null when there is no `origin` (or git cannot say).
 *
 * `execFileSync` with an argument array, never a shell string — a repository
 * path containing a space or a `;` is ordinary on a developer's machine and
 * would be a command-injection sink through `execSync`. Same discipline as
 * `project.ts`'s `gitToplevel`, for the same reason.
 */
export function gitRemoteUrl(dir) {
    const timeout = spawnTimeoutMs(GIT_TIMEOUT_MS);
    if (timeout === null)
        return null;
    try {
        const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout,
        });
        const url = out.trim();
        return url === "" ? null : url;
    }
    catch {
        // No `origin`, not a work tree, git missing, timeout — all the same answer:
        // we cannot name a remote, so the caller falls back to the local identity.
        return null;
    }
}
/**
 * Run one git command, or return null — the shared probe.
 *
 * ⚠ **AN ARGUMENT ARRAY, NEVER A SHELL STRING.** A repository path containing a
 * space or a `;` is ordinary on a developer's machine and a shell string is a
 * command-injection sink. Identical shape to `gitRemoteUrl` above and
 * `project.ts`'s `gitToplevel`: `-C <dir>`, utf8, stderr discarded, a
 * five-second bound, and a failure that resolves to a VALUE rather than
 * throwing.
 *
 * ⚠ **MOVED HERE FROM `src/commands/why.ts` BY `CR-108`**, because `report`
 * needs the same probe and a second copy is how the two drift. `why`'s screens
 * are byte-identical afterwards — `test/why.test.ts` is the oracle for that,
 * and the move changes no behaviour: this is the same function.
 */
export function gitProbe(dir, args) {
    const timeout = spawnTimeoutMs(GIT_TIMEOUT_MS);
    if (timeout === null)
        return null;
    try {
        return execFileSync("git", ["-C", dir, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout,
        });
    }
    catch {
        return null;
    }
}
/**
 * Is this a shallow clone?
 *
 * ⚠ **LOAD-BEARING RATHER THAN DEFENSIVE** (D67's posture), and it is the same
 * hazard for two different verbs. `git blame` on a shallow clone attributes
 * every line older than the graft boundary to the boundary commit; a
 * REACHABILITY question on a shallow clone is wrong the same way, because the
 * commits that would answer it may simply not be in the clone. Both return a
 * PLAUSIBLE WRONG ANSWER — D98's hazard class — and shallow clones live in CI
 * containers, which is where nobody is reading the output.
 *
 * ⚠ **FAILS CLOSED.** If git cannot answer, we do not know the clone is
 * complete, and an answer we cannot stand behind is worse than a refusal.
 */
export function isShallowClone(dir) {
    const out = gitProbe(dir, ["rev-parse", "--is-shallow-repository"]);
    return out === null || out.trim() !== "false";
}
/**
 * Is `sha` an ancestor of `ref` — i.e. still reachable from it?
 *
 * ⚠ **THE ONE THING THE SERVER CANNOT ANSWER.** `commit_coverage` returns the
 * shas we hold an edge for and deliberately no rate, because reachability is a
 * property of the user's clone and that process has no repository (D67). This
 * is the client half of that split.
 *
 * ⚠ **FAILS CLOSED, and the direction matters.** `merge-base --is-ancestor`
 * exits 0 for yes and 1 for no, so `gitProbe` returns `""` for reachable and
 * `null` for BOTH "not reachable" and "git could not answer". Those are
 * different facts, and collapsing them would silently count an unanswerable
 * probe as unreachable — deflating the rate rather than refusing it. So the
 * caller is handed `null` for "unknown" and must decide, and `report` refuses.
 */
export function isReachable(dir, sha, ref) {
    // `--quiet` so the exit code is the whole answer and nothing reaches stdout.
    if (gitProbe(dir, ["merge-base", "--is-ancestor", sha, ref]) !== null)
        return true;
    // ⚠ A REFUSAL AND A NEGATIVE ARE DIFFERENT ANSWERS. If `ref` does not resolve,
    // or the sha is not in this clone at all, the question was never asked — so
    // report `null` rather than folding it into a `false` the caller would count.
    //
    // ⚠ And note the phrasing above avoids the token `from` before a double
    // quote: `test/provenance.test.ts`'s linkage wall is a REGEX over raw text,
    // `/(?:from|import)\s*\(?\s*"([^"]+)"/`, so ordinary prose can read as an
    // import specifier escaping the package. `why.ts` carries the same warning.
    // This comment cost one red run to learn, in the direction that is safe.
    if (gitProbe(dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]) === null)
        return null;
    return gitProbe(dir, ["cat-file", "-e", `${sha}^{commit}`]) === null ? null : false;
}
/**
 * The `git patch-id` of one commit — the CLIENT-ASSERTED half of a successor
 * pair (`CR-133d`, D111 §1).
 *
 * ⚠ **THE CLIENT IS THE ONLY SIDE THAT CAN COMPUTE THIS.** The server provably
 * cannot: no git dependency, no clone, and its only `child_process` is a
 * best-effort `git show` on no live path (D108). A patch id is a fact about a
 * DIFF, so it survives the rewrite that changes the sha — which is what lets a
 * successor pair resolve through a rebase or GitHub's squash-merge button.
 *
 * ⚠ **IT IS EVIDENCE THE CLIENT ASSERTS, NOT SOMETHING WE WITNESSED** (D111 §1
 * condition 3, the same posture as `cli_read` in D73). Whatever consumes this
 * must record it as client-asserted; nothing here establishes that the caller's
 * repository is the one the server thinks it is.
 *
 * ⚠ **NULL RATHER THAN A GUESS, AND THE REASON IS PERMANENCE.** `match_kind` is
 * in the primary key and `reject_history_mutation` raises on every UPDATE
 * including `service_role` (D105, D108), so **a wrong row can never be
 * retracted**. That makes guessing not a degraded-but-acceptable mode. Every
 * unanswerable case below therefore returns `null`, exactly like `isReachable`
 * beside it, and the caller must be able to express "no patch id" as a state
 * rather than as a value.
 *
 * MEASURED cases that return `null` — none of them is an error:
 *   - a MERGE commit — `diff-tree` emits no patch for one, and a merge has no
 *     single diff to identify;
 *   - an EMPTY commit — nothing to hash;
 *   - a sha absent from this clone, which is the ordinary SHALLOW-clone case
 *     (`isShallowClone` above exists for the same reason);
 *   - git missing, a timeout, or output that is not a hex id.
 *
 * ⚠ `--root` is deliberate: without it the INITIAL commit of a repository has
 * no patch id at all, which would silently exclude the one commit every
 * repository has.
 *
 * ⚠ `--no-ext-diff` is load-bearing, not tidiness: a developer's configured
 * external differ would otherwise rewrite the bytes being hashed, and the
 * resulting id would be stable only on that machine.
 *
 * ⚠ **NO SHELL, so no pipe.** `git patch-id` normally reads a pipe; feeding it
 * through `input` keeps the argument-array rule `gitProbe` documents above — a
 * repository path containing a space or a `;` is ordinary.
 */
export function gitPatchId(dir, ref) {
    const diff = gitProbe(dir, ["diff-tree", "-p", "--root", "--no-color", "--no-ext-diff", ref]);
    // ⚠ An empty diff is NOT a failure — it is a merge, or an empty commit. Both
    // are "no patch id exists", which is the same answer as "we could not ask".
    if (diff === null || diff.trim() === "")
        return null;
    // ⚠ A SECOND SPAWN IN ONE FUNCTION, so it re-reads the budget rather than
    // reusing `gitProbe`'s number — the `diff-tree` above may have consumed most
    // of the window, and a stale timeout would let the pair overrun together.
    const timeout = spawnTimeoutMs(GIT_TIMEOUT_MS);
    if (timeout === null)
        return null;
    let out;
    try {
        out = execFileSync("git", ["-C", dir, "patch-id", "--stable"], {
            input: diff,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "ignore"],
            timeout,
        });
    }
    catch {
        return null;
    }
    // `patch-id` prints "<patch-id> <commit-ish>". Take the id and PROVE it is one
    // — anything else is a git we do not understand, and half an id is worse than
    // none. 40 hex for sha1 repositories, 64 for sha256.
    const id = out.trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(id) ? id : null;
}
/** A 40-hex sha1 or 64-hex sha256 object name. Nothing else is a sha. */
const SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
/**
 * `HEAD`'s sha and branch — **the ONE new spawn `CR-170` adds to the Claude Code
 * hook path**, and it is for REF MOVES, not for commits.
 *
 * Commits are observed by `post-commit` (D154), which cannot see a `pull`, a
 * `checkout` or a `reset --hard` — those move a ref **without creating a
 * commit**, so no commit hook fires and only a direct look at `HEAD` records it.
 *
 * ⛔ **ONE SPAWN, BUT NOT COMBINED WITH `--show-toplevel`.** MEASURED
 * 2026-08-17: `git rev-parse --show-toplevel nosuchref` prints the toplevel and
 * THEN exits **128**, so `execFileSync` throws and the toplevel is lost with it —
 * and on a repository with no commits `rev-parse HEAD` is exactly that case
 * (measured: exit 128, `HEAD` on stdout, a usage line on stderr). Folding the two
 * together would make an empty repo lose its project key, which is the `C3`
 * regression. The toplevel keeps its own spawn; this is the second.
 *
 * ⛔ **THE OUTPUT IS VALIDATED, NEVER TRUSTED.** MEASURED, same day: when the rev
 * argument is itself 40 hex, `rev-parse` exits **0 and ECHOES IT BACK** as though
 * it had resolved something. Nothing distinguishes that from a real answer except
 * checking the shape — the same reason `gitPatchId` tests its own return before
 * believing it. ⚠ Marked as an inference: the echo-back is not reachable from
 * THIS caller, which passes the literal `HEAD`, so the test below is defence
 * against a future caller and against a git we do not understand, not a live path.
 */
export function headRef(dir) {
    const out = gitProbe(dir, ["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]);
    if (out === null)
        return null;
    const lines = out.trim().split("\n");
    if (lines.length < 2)
        return null;
    const sha = lines[0].trim();
    if (!SHA.test(sha))
        return null;
    const ref = lines[1].trim();
    // `HEAD` is what `--abbrev-ref` prints when detached. Not a branch name.
    return { sha, branch: ref === "" || ref === "HEAD" ? null : ref };
}
/** The branch `HEAD` is on, or null on a detached HEAD or a failure. */
export function currentBranch(dir) {
    const out = gitProbe(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (out === null)
        return null;
    const ref = out.trim();
    // `HEAD` is what `--abbrev-ref` prints when detached. That is not a branch
    // name, and reporting "coverage on HEAD" would name nothing the reader can
    // check, so the caller asks for `--ref` instead of guessing.
    return ref === "" || ref === "HEAD" ? null : ref;
}
/**
 * `owner/repo` from a github.com remote, `host/owner/repo` from any other host,
 * or null when the URL cannot be named without guessing.
 *
 * ⚠ **RENAMED FROM `parseGitHubSlug` BY `CR-167`**, because it stopped being
 * about GitHub. A function that answers `gitlab.com/owner/repo` while calling
 * itself `parseGitHubSlug` is the kind of name the next reader trusts and should
 * not. Nothing outside this module and its test imported the old name.
 *
 * ## ⚠ SEGMENT COUNT IS THE DISCRIMINATOR, AND THE SERVER ALREADY PARSES IT
 *
 * `cr033a` §4 branches on the slash count: exactly one slash means the host is
 * IMPLIED to be github.com and segment 1 is the owner; otherwise segment 1 is
 * the host and segment 2 is the owner. This function emits into that grammar
 * rather than inventing one.
 *
 * ⛔ **github.com therefore stays UNQUALIFIED at two segments.**
 * `resolve_repository` matches the App-installation oracle on
 * `github_installation_repos.repo_full_name`, which is `owner/repo`. Qualifying
 * github.com would silently break every oracle join — the exact failure class
 * this change exists to fix, re-introduced from the other side.
 *
 * ## Null is still the safe answer, and that asymmetry is still the design
 *
 * A wrong slug is worse than no slug. `local:` is designed to be safe: it can
 * never collide with a real repository (neither a two- nor a three-segment slug
 * can contain a `:`), and `resolve_repository` resolves it ungated because a
 * local-only work tree has no external owner to check against. A
 * confidently-wrong slug, by contrast, attributes a capture to a repository the
 * user may not own. So every branch below still fails to null rather than
 * guessing, and callers turn null into `local:`.
 *
 * ⚠ **HOST-QUALIFYING DOES NOT WEAKEN THE SUFFIX-ATTACK GUARD, IT RELOCATES IT.**
 * `github.com.evil.example` no longer returns null — it returns
 * `github.com.evil.example/owner/repo`. The security property was never "returns
 * null"; it is **"is never mistaken for a github.com slug"**, and a three-segment
 * slug provably cannot collide with the two-segment github.com namespace. The
 * server agrees independently: `cr033a` §4 reads segment 1 as the HOST, so that
 * slug is scoped to a namespace claim on `github.com.evil.example`, never to
 * `owner`'s GitHub account.
 *
 * Exported for its own tests: the parsing is where the confidence lives, and it
 * is pure apart from one `ssh -G`, so it is tested directly rather than through
 * a spawned `git`.
 */
export function parseRemoteSlug(remoteUrl) {
    const raw = remoteUrl.trim();
    if (raw === "")
        return null;
    const parts = raw.includes("://") ? fromUrl(raw) : fromScpLike(raw);
    if (parts === null)
        return null;
    const segments = parts.path
        .replace(/\.git$/, "")
        .split("/")
        .filter((segment) => segment !== "");
    // EXACTLY two. A URL with more is not a remote — it is a web URL someone
    // pasted (`.../owner/repo/tree/main`), and silently taking its first two
    // segments would be exactly the confident guess this function refuses to make.
    //
    // ⚠ This bound is checked BEFORE `ssh -G` runs: a URL we are going to refuse
    // anyway must not cost a spawn on the hook's budget.
    if (segments.length !== 2)
        return null;
    const [owner, repo] = segments;
    if (!OWNER.test(owner))
        return null;
    if (!REPO.test(repo) || repo === "." || repo === "..")
        return null;
    // Hostnames are case-insensitive; `GitHub.com` is the same host.
    const host = resolveSshAlias(parts).toLowerCase();
    // A host we would not hand to `ssh` is a host we will not put on the wire
    // either. Same guard, same reason: doubt resolves to `local:`.
    if (!GITHUB_HOSTS.has(host) && !HOSTNAME.test(host))
        return null;
    const slug = GITHUB_HOSTS.has(host) ? `${owner}/${repo}` : `${host}/${owner}/${repo}`;
    // ⚠ THE SERVER'S BOUND, ENFORCED WHERE THE VALUE IS BUILT. `parseIngestHeaders`
    // 400s on a slug over `REPO_SLUG_MAX`, and a 400 loses the capture outright —
    // strictly worse than `local:`, which is always 18 characters and always
    // resolves. `OWNER` and `REPO` are unbounded `+` quantifiers by design (we do
    // not hardcode any forge's limits), so nothing upstream caps this.
    //
    // ⚠ Measured, both halves, because they have different provenance: a 300-char
    // HOST is a regression this change would otherwise introduce (such a remote
    // used to return null and fall to `local:`), while a 200+200 `owner/repo` on
    // github.com already returned 401 characters on `main`. One guard closes both.
    return slug.length <= SLUG_MAX ? slug : null;
}
/**
 * `parseIngestHeaders`'s upper bound on `X-Repo-Slug`, mirrored here.
 *
 * Duplicating the server's constant is deliberate: this module cannot import it
 * across the repo boundary, and the alternative is discovering the limit as a
 * 400 in the field. The lower bound needs no check — every branch above returns
 * either `null` or a slug containing at least one non-empty segment.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — REPO_SLUG_MAX, read
 */
const SLUG_MAX = 256;
/**
 * The remote's host, after resolving an `ssh_config` alias — the half of D157
 * that fixes this project's OWN dogfooding.
 *
 * ⚠ **AN SSH ALIAS IS INVISIBLE TO EVERY OTHER READER OF THE URL.** Our own
 * clones use `git@github-vibecommit:…`, mandatory because plain `git@github.com`
 * resolves to the wrong key, so `github-vibecommit` is not a hostname at all —
 * it is a key into the user's `~/.ssh/config`. Only `ssh` can expand it, so
 * `ssh -G <host>` is consulted and its `hostname` line taken. Measured on
 * OpenSSH 10.3: `ssh -G github-vibecommit` prints `hostname github.com`.
 *
 * ⚠ **ONLY FOR SSH TRANSPORTS, WHICH IS WHAT GIT ITSELF DOES.** An `https://`
 * host is a DNS name that never passes through `ssh_config`; expanding it would
 * let an unrelated `Host` stanza silently rewrite a web remote. So the flag
 * comes from the parse — scp-like form and `ssh://` only, never `https`, `http`
 * or `git://`.
 *
 * ⚠ **AND NEVER FOR A HOST THAT IS ALREADY KNOWN-GITHUB.** Measured identity
 * (`ssh -G github.com` → `github.com`), so the spawn would buy nothing — and
 * this is the common case, which means the overwhelming majority of hooks pay
 * ZERO new process spawns for this change. Only alias and self-hosted users pay,
 * and they pay ~4ms (measured: 10 runs in 41ms, no network I/O — `-G` evaluates
 * config and does not connect or resolve DNS).
 *
 * ⚠ **EVERY FAILURE RETURNS THE HOST UNCHANGED, WHICH IS EXACTLY TODAY'S
 * BEHAVIOUR.** `ssh` absent (a minimal container), too old for `-G` (pre-6.8),
 * a `Match exec` stanza that errors, a timeout, or output with no `hostname`
 * line — all mean "we could not expand this", and an unexpanded host is the
 * status quo rather than a new failure mode. Nothing here can make a slug worse
 * than it is today; it can only fail to improve it.
 *
 * ⚠ **THE BOUND IS 2s, TIGHTER THAN THE 5s ITS NEIGHBOURS USE.** This runs on
 * the hook path, where a synchronous spawn blocks the event loop and therefore
 * defeats the watchdog outright (`TODOS[87]`), so a NEW spawn there earns a
 * tighter bound than the git probes that predate the concern. 2s is ~500x the
 * measured cost; the only way to approach it is a user's own `Match exec`.
 */
function resolveSshAlias(parts) {
    const { host, ssh } = parts;
    if (!ssh)
        return host;
    if (GITHUB_HOSTS.has(host.toLowerCase()))
        return host;
    // ⛔ Never hand `ssh` an option-shaped string — see `HOSTNAME`.
    if (!HOSTNAME.test(host))
        return host;
    // ⚠ THE FIFTH CONSUMER OF THE HOOK'S SPAWN BUDGET (`CR-167` added it after
    // `TODOS[87]` was written). Its 2s ceiling was already tighter than the git
    // probes' 5s precisely because it runs on the hook path — but a ceiling is not
    // a bound, so it now derives from the same shared window as the rest.
    const timeout = spawnTimeoutMs(SSH_TIMEOUT_MS);
    // Budget spent: the host is returned UNEXPANDED, which is the same answer as
    // ssh being absent — a slug that is merely unqualified, never a wrong one.
    if (timeout === null)
        return host;
    let out;
    try {
        // `--` is the second guard: even if `HOSTNAME` were widened one day, ssh
        // stops reading flags here. Verified on OpenSSH 10.3 — with `--`, an
        // option-shaped host is rejected as a hostname rather than parsed as a flag.
        out = execFileSync("ssh", ["-G", "--", host], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout,
        });
    }
    catch {
        return host;
    }
    for (const line of out.split("\n")) {
        // ⚠ `hostname`, NOT `host`. `ssh -G` prints BOTH, and `host` echoes the
        // ALIAS we asked about — taking it would make this function a no-op that
        // looks like it works. Anchored and tokenised so `hostname` cannot match
        // the `host` line's prefix.
        const found = /^hostname[ \t]+(\S+)[ \t]*$/.exec(line);
        // Re-check the ANSWER, not just the question: `ssh_config` is user-supplied
        // and its `HostName` can be anything, including a `%h` token that did not
        // expand.
        if (found !== null)
            return HOSTNAME.test(found[1]) ? found[1] : host;
    }
    return host;
}
/**
 * `https://`, `ssh://`, `git://` — anything with a scheme.
 *
 * `ssh` marks the ones git routes through `ssh_config`, and it is TRUE only for
 * `ssh:`. `git:` is the git daemon protocol and `https:`/`http:` are web
 * transports; none of them consults an ssh alias, so neither do we.
 */
function fromUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return null;
    }
    // `git+ssh://` and friends parse, but a scheme we have not reasoned about is
    // a doubt, and doubt resolves to `local:`.
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol))
        return null;
    // `url.hostname` drops any userinfo and port for us, which is what makes
    // `ssh://git@ssh.github.com:443/owner/repo.git` resolve correctly.
    return { host: url.hostname, path: url.pathname, ssh: url.protocol === "ssh:" };
}
/**
 * The scp-like form git accepts: `[user@]host:path`, e.g.
 * `git@github.com:owner/repo.git`.
 *
 * Not a URL, so `new URL` cannot read it — and misreading it as one is a real
 * hazard rather than a hypothetical: `new URL("git@github.com:owner/repo")`
 * succeeds with protocol `git@github.com:`, which would sail past a naive
 * scheme check.
 *
 * ⚠ **ALWAYS `ssh: true`** — this form is ssh-only in git, and it is the form
 * every aliased remote takes, so it is the whole reason `resolveSshAlias`
 * exists. `git@github-vibecommit:Vibe-Commit/vibecommit-capture.git` reaches
 * here with host `github-vibecommit`, which is not a hostname at all.
 */
function fromScpLike(raw) {
    const match = /^(?:[^@/]+@)?([^@/:]+):(.+)$/.exec(raw);
    if (match === null)
        return null;
    const [, host, path] = match;
    return { host, path, ssh: true };
}
/**
 * The local-only identity: `local:` plus 12 hex of the toplevel's SHA-256.
 *
 * Shape and prefix are both fixed by the server (D58 §ER25) — `resolve_repository`
 * branches on `v_slug not like 'local:%'` to skip the ownership oracle, because
 * a work tree with no remote has no external owner and gating it would gate a
 * developer against themselves. The prefix is emitted lowercase because this
 * module constructs it: the server's own canonicalisation would also lowercase
 * it, but relying on that for a literal we control would be relying on someone
 * else's normalisation to make our own output correct.
 *
 * A digest rather than the path itself: the path is 1..256-bounded only by luck,
 * it can exceed the server's `REPO_SLUG_MAX`, and it would put an absolute
 * filesystem path — usernames included — into a server-side row and its
 * `display_name`.
 */
function localSlug(toplevel) {
    return `local:${createHash("sha256").update(toplevel).digest("hex").slice(0, 12)}`;
}
//# sourceMappingURL=git.js.map