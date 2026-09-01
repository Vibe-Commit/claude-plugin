#!/usr/bin/env node
/**
 * `vibecommit` — CLI entry point.
 *
 * Verb bodies that are NOT here, each an owned task in
 * `coordination/CAPTURE_REFACTOR_TASKS.md`:
 *
 *   why  CR-086   report  CR-108   connect's live-capture ending  CR-025
 *   status/off output spec  CR-021   failure policy  CR-018
 *   repo binding key + X-Repo-Slug  CR-017 / CR-019
 *
 * What IS established here, and must not be undone by those tasks:
 *   - no user-facing string literal in a command body (CR-090 → `src/copy/`)
 *   - the exit-code contract is split hook vs interactive (CR-022 → `src/exit.ts`)
 *   - one commit-header renderer taking the grade (CR-090 → `src/copy/grades.ts`)
 *   - every escape sequence comes from `src/term.ts` (DESIGN.md §13.2)
 *   - the hook contract is enforced by the entry, not by each verb
 */
import { writeSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { resolveAgentId } from "./agents/registry.js";
import { auth } from "./commands/auth.js";
import { connect } from "./commands/connect.js";
import { off, status } from "./commands/status.js";
import { report } from "./commands/report.js";
import { why } from "./commands/why.js";
import { HELP, INTERNAL, USAGE } from "./copy/index.js";
import { EXIT } from "./exit.js";
import { runHook } from "./hooks/entry.js";
import { runPostCommit } from "./hooks/post_commit.js";
import { runPostRewrite } from "./hooks/post_rewrite.js";
import { LABEL_GUTTER, renderErrorBlock, resolveColour, wrap } from "./term.js";
import { CLIENT_VERSION } from "./version.js";
// `CR-216/U2` adds `auth`, and adding it MOVES `test/help.golden.txt` — which
// `CR-084d` and the `post-commit` note below were both careful not to do. The
// difference is the point: those two are a FLAG and a HIDDEN verb, neither of
// which a human types, so moving the golden file for them would have been noise.
// `auth` is typed by a human on a new machine before anything else works, so a
// help screen that omitted it would be the defect one layer up. The golden file
// exists to make a change to that screen deliberate, not to make it impossible.
const VERBS = ["auth", "connect", "status", "off", "why", "report"];
export function isVerb(value) {
    return VERBS.includes(value);
}
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
 * `--help`, wrapped hard at 80 columns per DESIGN.md §13.4.
 *
 * Never reflows to `process.stdout.columns`: identical commands must emit
 * identical bytes, or issue-paste, screenshots and every golden-file test of the
 * copy break. `test/help-golden.test.ts` is that golden file.
 *
 * No SGR here at all. Colour would have to be resolved before help could be
 * rendered, and help is the one surface where structure alone is enough —
 * indentation and the label gutter carry it, which is §13.1's point about
 * `NO_COLOR` being a lossless degradation rather than a downgrade.
 */
export function renderHelp() {
    const lines = [
        ...wrap(HELP.tagline, 2),
        "",
        ...wrap(`${USAGE.usageLabel} ${HELP.usage}`, 2),
        "",
        ...wrap(USAGE.commandsLabel, 2),
    ];
    for (const verb of VERBS) {
        // The description is wrapped on its own and the verb column is written over
        // the first line's indent. Wrapping `verb + padding + description` as one
        // string would not work: `wrap` normalises whitespace, so the fixed gutter
        // would collapse to a single space.
        const head = `    ${verb.padEnd(LABEL_GUTTER)}`;
        const body = wrap(HELP.commands[verb], head.length);
        lines.push(head + body[0].slice(head.length), ...body.slice(1));
    }
    lines.push("", ...wrap(`${USAGE.docsLabel} ${HELP.docsUrl}`, 2));
    return lines.join("\n");
}
function interactiveContext(argv) {
    return {
        env: process.env,
        home: homedir(),
        cwd: process.cwd(),
        nodeVersion: process.versions.node,
        // `CR-183`. Resolved from argv HERE, the same pure read the hook branch at
        // the bottom of this file makes — `connect` needs it to know whether the
        // agent it was told about has a way to find the running session at all.
        agentId: resolveAgentId(argv),
        colour: resolveColour({
            env: process.env,
            isTty: process.stdout.isTTY === true,
            noColorFlag: argv.includes("--no-color"),
            json: argv.includes("--json"),
        }),
        stdinIsTty: process.stdin.isTTY === true,
        stdout: process.stdout,
        stderr: process.stderr,
        /**
         * The readline interface is created HERE, on the first question, and not
         * once per invocation — CR-117.
         *
         * `createInterface` RESUMES stdin, and a resumed stdin keeps the event loop
         * alive until it ends. Built eagerly, a verb that returns without ever
         * prompting sat there until the pipe closed: `connect` refusing a non-TTY,
         * and `status` / `off`, which never ask anything. On a terminal that looked
         * fine, because stdin ends at EOF; under `cmd | vibecommit connect` in CI it
         * is the hang the source finding names first, burning the job's whole
         * timeout with the refusal already on screen and no way to explain it.
         *
         * It also makes style guide §10.2 rule 2 literally true rather than nearly
         * true: on the refusal path stdin is not read, resumed, or opened at all.
         */
        ask: async (question) => {
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            try {
                return await rl.question(question);
            }
            finally {
                rl.close();
            }
        },
        now: () => new Date(),
        selfPath: process.argv[1] ?? "",
    };
}
async function main(argv) {
    const [verb] = argv;
    if (verb === undefined || verb === "--help" || verb === "-h") {
        process.stdout.write(`${renderHelp()}\n`);
        return EXIT.ok;
    }
    if (verb === "--version" || verb === "-v") {
        process.stdout.write(`${CLIENT_VERSION}\n`);
        return EXIT.ok;
    }
    if (!isVerb(verb)) {
        process.stderr.write(`${USAGE.unknownCommand(verb)}\n\n${renderHelp()}\n`);
        return EXIT.usage;
    }
    const ctx = interactiveContext(argv);
    switch (verb) {
        case "auth":
            // `CR-216/U2`. Both readers are injected here rather than reached for
            // inside the verb, the same way `why` takes its reader: the suite drives
            // every arm, and neither a TTY nor a pipe can be typed into by a test.
            return await auth(ctx, argv.slice(1), {
                readSecret: readSecretFromTty,
                readStdin,
            });
        case "connect":
            // `--sign-in` (CR-084d) is a FLAG, not a verb: `VERBS` is what `renderHelp`
            // iterates, so a sixth verb would move `test/help.golden.txt`, and the
            // brief for this task is explicit that the golden file must not move.
            return await connect(ctx, { signIn: argv.includes("--sign-in") });
        case "status":
            // `argv.slice(1)` for the same reason `why` and `report` take it: `status`
            // reads its own `--json` flag rather than this package acquiring an
            // argument parser it has deliberately never had (DESIGN.md §13.3).
            return status(ctx, argv.slice(1));
        case "off":
            return off(ctx);
        case "why":
            // CR-086. `argv.slice(1)` is everything after the verb — there is no
            // argument parser in this package and `why` does not add one; it reads
            // `<file>:<line>` and refuses `--json`, which is the smallest shape that
            // satisfies the verbatim-approved `--help` sentence.
            return await why(ctx, argv.slice(1));
        case "report":
            // CR-108, W10. Same shape as `why`: `argv.slice(1)` is everything after
            // the verb, and the verb reads its own two flags rather than adding an
            // argument parser this package deliberately does not have.
            return await report(ctx, argv.slice(1));
    }
}
/**
 * Read a secret from the terminal WITHOUT ECHOING IT — `CR-216/U2`.
 *
 * `ctx.ask` is not reusable for this. It is the consent prompt: it echoes, which
 * is correct for `y/N` and wrong for a long-lived credential, which would then
 * sit in the terminal's scrollback to be scrolled back to, screenshotted into a
 * bug report, or captured by a terminal logger.
 *
 * The mute is the ordinary readline technique: `output` receives the prompt
 * first and is muted only for the keystrokes that follow, so the question is
 * still visible and the answer never is. The trailing newline is ours to write —
 * the user's own Return was swallowed with the rest, and without it whatever
 * prints next lands on the prompt line.
 *
 * Nothing here holds the secret: `rl.question`'s resolved string goes straight to
 * the caller, which wraps it in an `IngestCredential` before doing anything else
 * with it.
 */
function readSecretFromTty(prompt) {
    let muted = false;
    const muffled = new Writable({
        write(chunk, encoding, cb) {
            if (!muted)
                process.stdout.write(chunk, encoding);
            cb();
        },
    });
    const rl = createInterface({ input: process.stdin, output: muffled, terminal: true });
    const answer = rl.question(prompt);
    muted = true;
    return answer.finally(() => {
        rl.close();
        process.stdout.write("\n");
    });
}
function readStdin() {
    return new Promise((resolve) => {
        let buf = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => {
            buf += chunk;
        });
        process.stdin.on("end", () => resolve(buf));
        process.stdin.on("error", () => resolve(""));
    });
}
/**
 * The INTERACTIVE half of the split exit contract — CR-022, D61 round 3 §D8.
 *
 * The hook half is enforced in `hooks/entry.ts`: swallow everything, exit 0, stay
 * silent, because a non-zero hook feeds stderr back into the user's agent and
 * derails the task they were actually doing. **An interactive verb must not
 * inherit that blanket.** As originally written the exit-0/stdout-empty rule read
 * as governing the whole binary, which would make `why` on a read-lane 5xx exit 0
 * and print nothing — a read verb failing silently, which is the defect this
 * split exists to prevent.
 *
 * So: same fault, same binary, two modes, two behaviours. Interactive gets exit 1
 * and §13.6's shape.
 *
 * Two things this deliberately does NOT do:
 *   - **No signal handling.** `Ctrl-C` cancelling a `connect` prompt is normal
 *     CLI behaviour, and suppressing `SIGINT` globally would be a UX regression
 *     dressed up as a fix. The hook's signal override stays scoped to hook mode.
 *   - **No stack trace** unless `VIBECOMMIT_DEBUG` is set (§13.6, first
 *     prohibition). The detail then goes out RAW, after the block, rather than
 *     through `wrap()`, which would reflow a stack into nonsense.
 */
function reportUnexpected(error, argv) {
    const colour = resolveColour({
        env: process.env,
        isTty: process.stderr.isTTY === true,
        noColorFlag: argv.includes("--no-color"),
        json: argv.includes("--json"),
    });
    const lines = renderErrorBlock({
        kind: "bad",
        what: INTERNAL.unexpectedWhat,
        why: [INTERNAL.unexpectedWhy],
        fixLabel: INTERNAL.unexpectedFix,
        fixes: [INTERNAL.unexpectedDebugCommand],
    }, colour);
    if (process.env.VIBECOMMIT_DEBUG !== undefined)
        lines.push("", detailOf(error));
    // `writeSync(2, …)` rather than `process.stderr.write`: stderr to a pipe is
    // asynchronous and `process.exit` does not flush it, so the caller below would
    // race its own diagnostic away. Same reason `finish()` uses it on fd 1.
    try {
        writeSync(2, `${lines.join("\n")}\n`);
    }
    catch {
        // An unwritable stderr is not worth a second exception on this path.
    }
}
/**
 * The raw detail, for `VIBECOMMIT_DEBUG` only.
 *
 * Interpolating an error is safe by construction here: an `IngestCredential`
 * renders `vcik_…redacted` through `toString`, `toJSON` and the inspect hook, so
 * a stack that embedded one cannot print the plaintext.
 */
function detailOf(error) {
    if (error instanceof Error && typeof error.stack === "string")
        return error.stack;
    return String(error);
}
/**
 * Catch what escapes `main()` entirely — a stray timer's throw, a rejection from
 * a promise nobody awaited. Without these, Node prints its own stack trace to
 * stderr, which §13.6 forbids outright.
 *
 * These force an exit rather than setting `process.exitCode`, because by
 * definition something unexpected is still in flight and may be holding the event
 * loop open. The `main()` rejection path below does not: nothing is in flight
 * there, and letting the loop drain preserves whatever the verb already wrote.
 */
function installInteractiveGuards(argv) {
    const fail = (error) => {
        reportUnexpected(error, argv);
        process.exit(EXIT.failure);
    };
    process.on("uncaughtException", fail);
    process.on("unhandledRejection", fail);
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
// Only run when executed as the binary, so tests can import the module freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
    installPipeGuards();
    const argv = process.argv.slice(2);
    if (argv[0] === "post-commit") {
        // ⛔ A HIDDEN VERB, dispatched here rather than through `main`, and NOT in
        // `VERBS` — `renderHelp` iterates that list, so adding it would move
        // `test/help.golden.txt` for a verb no human ever types. `hook` is dispatched
        // the same way, for the same reason.
        //
        // It runs inside the user's `git commit`, so it exits 0 unconditionally and
        // writes nothing to either stream (`hooks/post_commit.ts`).
        //
        // ⛔ `env` IS THE LADDER'S FIRST RUNG. Claude Code exports
        // `CLAUDE_CODE_SESSION_ID` into the Bash tool's environment and git passes it
        // through to us (`M1`), so the committing session identifies ITSELF instead of
        // being guessed at by mtime. This is the one place the real environment is
        // read on this path; everything below takes it as a parameter.
        process.exit(runPostCommit({ home: homedir(), cwd: process.cwd(), env: process.env }));
    }
    if (argv[0] === "post-rewrite") {
        // The other hidden verb, for the same reason — and it is `post-commit`'s
        // other half: `--amend` and `rebase` fire `post-commit` for a sha they then
        // DESTROY (`M5`), and this is the only hook git tells about the pairing.
        //
        // ⛔ THE PAIRS ARRIVE ON STDIN, and it is read HERE so `hooks/post_rewrite.ts`
        // opens nothing — the same seam that keeps every other module in this package
        // free of a real file descriptor. ⚠ `readStdin` REUSED rather than a second
        // synchronous reader beside it: it already resolves an `error` to `""`, and
        // two stdin readers in one file is how the two come to disagree about what an
        // unreadable stream means. An empty read parses to zero pairs, which is an
        // ordinary answer rather than a failure.
        void readStdin().then((stdin) => process.exit(runPostRewrite({
            home: homedir(),
            cwd: process.cwd(),
            env: process.env,
            // git's own `argv[1]` — `amend` or `rebase`.
            kind: argv[1] ?? "",
            stdin,
        })));
        // ⛔ `else if` FROM HERE, AND THE BRANCH ABOVE IS WHY. Reading stdin is
        // asynchronous, so unlike `post-commit` this block RETURNS rather than
        // exiting — and a plain `if` below would then run `main(["post-rewrite"])`
        // synchronously, print an unknown-verb error, and put it in the terminal of
        // someone in the middle of a `git rebase`. The contract this hook is held to
        // is silence.
    }
    else if (invocationMode(process.env, argv) === "hook") {
        // `runHook` installs the contract guards before it does any work and always
        // calls `process.exit(0)`. It never returns, so nothing follows it.
        void runHook({
            env: process.env,
            home: homedir(),
            nodeVersion: process.versions.node,
            // ⛔ `CR-183` — THE ONE PLACE THE FLAG IS READ ON THIS PATH, and it is read
            // HERE rather than inside the hook for a structural reason: `runHook` never
            // receives argv at all, and `parseHookInput` must not select the adapter
            // because stdin is the input the confinement boundary exists to constrain.
            // This is the seam that already injects `home` and `nodeVersion`.
            //
            // ⚠ Note what the line ABOVE this block does and does not do: resolving an
            // id is not entering hook mode. `invocationMode` keys on `argv[0]`, so the
            // registered command MUST lead with the `hook` verb — put the flag first
            // and this branch is never taken.
            agentId: resolveAgentId(argv),
            readStdin,
        });
    }
    else {
        installInteractiveGuards(argv);
        void main(argv).then((code) => {
            process.exitCode = code;
        }, (error) => {
            reportUnexpected(error, argv);
            process.exitCode = EXIT.failure;
        });
    }
}
//# sourceMappingURL=index.js.map