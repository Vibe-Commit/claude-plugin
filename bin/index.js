#!/usr/bin/env node
/**
 * `vibecommit` — the process entry. A DISPATCHER, and deliberately nothing more.
 *
 * ⛔ THIS FILE'S STATIC IMPORTS ARE THE LOAD COST OF EVERY HOOK. It used to import every interactive verb (`auth`,
 * `connect`, `status`, the OAuth stack...), so `vibecommit hook` and the git hooks paid ~390 ms of module loading for code
 * they never run. Now each branch below loads only what it runs, with a dynamic `import()`, and the interactive half
 * lives in `cli.ts`. `test/load-path.test.ts` fails the build if a value import of an interactive verb reaches a hook path.
 *
 * What is established in `cli.ts`, and must not be undone:
 *   - no user-facing string literal in a command body (CR-090 → `src/copy/`)
 *   - the exit-code contract is split hook vs interactive (CR-022 → `src/exit.ts`)
 *   - the hook contract is enforced by the entry, not by each verb
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { EXIT } from "./exit.js";
import { readStdin } from "./stdin.js";
import { isVerb } from "./verbs.js";
export { isVerb };
/**
 * Hook invocations are distinguished by ARGV FIRST, then by env.
 *
 * ⚠ `CLAUDE_HOOK_EVENT` is **not** a variable Claude Code sets. The documented
 * contract puts `hook_event_name` on **stdin JSON**, and the environment carries
 * `CLAUDE_PROJECT_DIR` / `CLAUDE_PLUGIN_ROOT` — neither of which identifies a
 * hook event. Keying the mode off that variable alone would make every hook
 * invocation run in INTERACTIVE mode, which is the shape of a contract test that
 * passes while testing nothing.
 *
 * So the primary signal is the one we control: `CR-028`'s `hooks.json` invokes
 * `vibecommit hook`. The env var is kept as a secondary because the scaffold
 * established it and a wrapper may already set it.
 */
export function invocationMode(env, argv) {
    if (argv[0] === "hook")
        return "hook";
    return env.CLAUDE_HOOK_EVENT ? "hook" : "interactive";
}
/**
 * Swallow EPIPE.
 *
 * `vibecommit --help | head` closes stdout mid-write, and Node's default for an
 * unhandled stream error is to print a stack trace and exit non-zero. §13.6
 * forbids the stack trace outright, and a non-zero exit for an ordinary
 * `| head` would teach a wrapper script that the command failed.
 */
function installPipeGuards() {
    for (const stream of [process.stdout, process.stderr]) {
        stream.on("error", (err) => {
            if (err.code === "EPIPE")
                process.exit(EXIT.ok);
        });
    }
}
/**
 * Are we being executed AS the binary, rather than imported?
 *
 * ⛔ THIS MUST COMPARE REAL PATHS, AND THE STRING COMPARISON THAT USED TO LIVE
 * HERE MADE THE ENTIRE npm CLI INERT. `npm install -g` links
 * `<prefix>/bin/vibecommit` as a SYMLINK to
 * `<prefix>/lib/node_modules/@vibe-commit/capture/dist/index.js`. Node sets
 * `process.argv[1]` to the path the user invoked — the symlink — while
 * `import.meta.url` always resolves to the real file. So
 * `import.meta.url === \`file://${process.argv[1]}\`` was FALSE for every
 * globally-installed user, this block never ran, and `vibecommit auth`,
 * `connect` and `status` all wrote NOTHING and exited 0. Shipped that way in
 * `0.2.0` and `0.2.1`.
 *
 * ⚠ WHY NOTHING CAUGHT IT, WHICH IS THE PART WORTH KEEPING. The two paths that
 * were exercised both bypass the symlink: the test suite imports this module
 * directly (which is what the old comment here was protecting), and the plugin
 * registers `node "${CLAUDE_PLUGIN_ROOT}/bin/index.js" hook` — an explicit real
 * path. **Only `npm install -g` goes through a link, and nothing ever executed
 * that path.** A symbol check on the published tarball passes, because the code
 * is present and correct; it is the INVOCATION that was broken. `TODOS[133]`.
 *
 * `realpathSync` throws on a dangling path, so both sides are guarded — a
 * failure to resolve means "not the binary", never a crash on import.
 */
function invokedAsBinary() {
    const invoked = process.argv[1];
    if (!invoked)
        return false;
    try {
        return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
    }
    catch {
        return false;
    }
}
/**
 * Every dispatch below is a dynamic `import()` that FAILS CLOSED to the verb's own contract. A hook, `post-commit` and
 * `post-rewrite` run inside the user's agent or `git commit`: an import that throws (a plugin update replacing `bin/` under a
 * running process, a truncated install) must exit 0 and print nothing, not put a stack trace in their terminal. The
 * interactive branch is the opposite on purpose: a broken install should be LOUD there, so its rejection is not caught.
 */
if (invokedAsBinary()) {
    installPipeGuards();
    const argv = process.argv.slice(2);
    if (argv[0] === "post-commit") {
        // ⛔ A HIDDEN VERB, dispatched here rather than through `main`, and NOT in `VERBS` — `renderHelp` iterates that list, so
        // adding it would move `test/help.golden.txt` for a verb no human ever types. `hook` is dispatched the same way.
        //
        // It runs inside the user's `git commit`, so it exits 0 unconditionally and writes nothing to either stream
        // (`hooks/post_commit.ts`).
        //
        // ⛔ `env` IS THE LADDER'S FIRST RUNG. Claude Code exports `CLAUDE_CODE_SESSION_ID` into the Bash tool's environment and
        // git passes it through to us (`M1`), so the committing session identifies ITSELF instead of being guessed at by mtime.
        // This is the one place the real environment is read on this path; everything below takes it as a parameter.
        void import("./hooks/post_commit.js")
            .then(({ runPostCommit }) => process.exit(runPostCommit({ home: homedir(), cwd: process.cwd(), env: process.env })))
            .catch(() => process.exit(EXIT.ok));
    }
    else if (argv[0] === "post-rewrite") {
        // The other hidden verb, for the same reason — and it is `post-commit`'s other half: `--amend` and `rebase` fire
        // `post-commit` for a sha they then DESTROY (`M5`), and this is the only hook git tells about the pairing.
        //
        // ⛔ THE PAIRS ARRIVE ON STDIN, and it is read HERE so `hooks/post_rewrite.ts` opens nothing — the same seam that keeps
        // every other module in this package free of a real file descriptor. `readStdin` resolves an `error` to `""`, and an empty
        // read parses to zero pairs, which is an ordinary answer rather than a failure.
        void Promise.all([import("./hooks/post_rewrite.js"), readStdin()])
            .then(([{ runPostRewrite }, stdin]) => process.exit(runPostRewrite({
            home: homedir(),
            cwd: process.cwd(),
            env: process.env,
            // git's own `argv[1]` — `amend` or `rebase`.
            kind: argv[1] ?? "",
            stdin,
        })))
            .catch(() => process.exit(EXIT.ok));
    }
    else if (argv[0] === "__upload-worker") {
        // The third hidden verb: the detached upload worker (U5). Spawned by a hook with `stdio: "ignore"`, so it has nobody to talk to and exits 0
        // unconditionally. Dispatched BEFORE the env-keyed hook branch below, so an inherited `CLAUDE_HOOK_EVENT` cannot route it into the hook.
        // Not in `VERBS`, for the same reason `hook` is not: `renderHelp` iterates that list and no human types this.
        void import("./commands/upload_worker.js")
            .then(({ runUploadWorkerMain }) => runUploadWorkerMain(process.env, homedir()))
            .then((code) => process.exit(code))
            .catch(() => process.exit(EXIT.ok));
    }
    else if (invocationMode(process.env, argv) === "hook") {
        // `runHook` installs the contract guards before it does any work and always calls `process.exit(0)`. It never returns, so
        // nothing follows it.
        void Promise.all([import("./hooks/entry.js"), import("./agents/registry.js")])
            .then(([{ runHook }, { resolveAgentId }]) => runHook({
            env: process.env,
            home: homedir(),
            nodeVersion: process.versions.node,
            // ⛔ `CR-183` — THE ONE PLACE THE FLAG IS READ ON THIS PATH, and it is read HERE rather than inside the hook for a
            // structural reason: `runHook` never receives argv at all, and `parseHookInput` must not select the adapter because
            // stdin is the input the confinement boundary exists to constrain. This is the seam that already injects `home` and
            // `nodeVersion`.
            //
            // ⚠ Resolving an id is not entering hook mode. `invocationMode` keys on `argv[0]`, so the registered command MUST
            // lead with the `hook` verb — put the flag first and this branch is never taken.
            agentId: resolveAgentId(argv),
            readStdin,
            // `11A`: state 2 names the command that reconnects THIS install.
            selfPath: process.argv[1] ?? "",
        }))
            .catch(() => process.exit(EXIT.ok));
    }
    else {
        void import("./cli.js").then(({ runCli }) => runCli(argv));
    }
}
//# sourceMappingURL=index.js.map