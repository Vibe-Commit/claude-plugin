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
/**
 * Hosts whose URLs are confidently GitHub.com.
 *
 * `ssh.github.com` is GitHub's documented port-443 SSH endpoint, used by anyone
 * behind a firewall that blocks 22. It is the same host in every sense that
 * matters here, and dropping those users to `local:` would silently cost them
 * repository attribution for a config GitHub itself tells them to use.
 *
 * GHES and every other forge are deliberately NOT here — see `resolveRepoSlug`.
 */
const GITHUB_HOSTS = new Set(["github.com", "ssh.github.com"]);
/**
 * A GitHub account name: alphanumerics and hyphens, no leading or trailing
 * hyphen. Deliberately GitHub's own rule rather than "anything without a
 * slash" — see the confidence note on `resolveRepoSlug`.
 */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A GitHub repository name. `.` and `..` are excluded below, not here. */
const REPO = /^[A-Za-z0-9._-]+$/;
/**
 * `owner/repo` for a work tree whose `origin` is GitHub, else
 * `local:<sha256(abspath)[0:12]>`.
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
 */
export function resolveRepoSlug(toplevel) {
    const remote = gitRemoteUrl(toplevel);
    const slug = remote === null ? null : parseGitHubSlug(remote);
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
    try {
        const out = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 5_000,
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
 * `owner/repo` from a GitHub remote URL, or null for anything else.
 *
 * ## Null is the safe answer, and that asymmetry is the whole design
 *
 * A wrong slug is worse than no slug. `local:` is designed to be safe: it can
 * never collide with a real repository (a GitHub `owner/repo` cannot contain a
 * `:`), and `resolve_repository` resolves it ungated because a local-only work
 * tree has no external owner to check against. A confidently-wrong `owner/repo`,
 * by contrast, attributes a capture to a repository the user may not own, and
 * the server cannot catch it — the oracle can only tell that a slug parses and
 * who owns it, never that it was derived from the wrong URL. So every branch
 * below fails to null rather than guessing, and callers turn null into `local:`.
 *
 * Exported for its own tests: the parsing is where the confidence lives, and it
 * is pure, so it is tested directly rather than through a spawned `git`.
 */
export function parseGitHubSlug(remoteUrl) {
    const raw = remoteUrl.trim();
    if (raw === "")
        return null;
    const parts = raw.includes("://") ? fromUrl(raw) : fromScpLike(raw);
    if (parts === null)
        return null;
    const { host, path } = parts;
    // Hostnames are case-insensitive; `GitHub.com` is the same host.
    if (!GITHUB_HOSTS.has(host.toLowerCase()))
        return null;
    const segments = path
        .replace(/\.git$/, "")
        .split("/")
        .filter((segment) => segment !== "");
    // EXACTLY two. A URL with more is not a remote — it is a web URL someone
    // pasted (`.../owner/repo/tree/main`), and silently taking its first two
    // segments would be exactly the confident guess this function refuses to make.
    if (segments.length !== 2)
        return null;
    const [owner, repo] = segments;
    if (!OWNER.test(owner))
        return null;
    if (!REPO.test(repo) || repo === "." || repo === "..")
        return null;
    return `${owner}/${repo}`;
}
/** `https://`, `ssh://`, `git://` — anything with a scheme. */
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
    return { host: url.hostname, path: url.pathname };
}
/**
 * The scp-like form git accepts: `[user@]host:path`, e.g.
 * `git@github.com:owner/repo.git`.
 *
 * Not a URL, so `new URL` cannot read it — and misreading it as one is a real
 * hazard rather than a hypothetical: `new URL("git@github.com:owner/repo")`
 * succeeds with protocol `git@github.com:`, which would sail past a naive
 * scheme check.
 */
function fromScpLike(raw) {
    const match = /^(?:[^@/]+@)?([^@/:]+):(.+)$/.exec(raw);
    if (match === null)
        return null;
    const [, host, path] = match;
    return { host, path };
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