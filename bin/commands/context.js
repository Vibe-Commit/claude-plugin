/**
 * What an interactive verb is handed.
 *
 * Everything ambient — env, home, cwd, the TTY answer, the clock — arrives as
 * data. No verb calls `os.homedir()`, `process.cwd()` or `Date.now()` itself,
 * which is what lets the tests drive a real binary against a temp HOME without
 * the risk of a test run touching the developer's own credentials.
 */
import { emitJsonError } from "../json.js";
import { ERRORS } from "../copy/index.js";
import { renderErrorBlock, tildePath, truncatePath } from "../term.js";
export function writeLines(stream, lines) {
    if (lines.length === 0)
        return;
    stream.write(`${lines.join("\n")}\n`);
}
/**
 * A `bad` block, written the way the verb's mode wants it: under `--json` ONE failure document on stdout and nothing on
 * stderr; otherwise §13.6's block on stderr. `lead` is the blank line some callers print before the block.
 */
export function writeFailure(ctx, block, json = null, lead = []) {
    if (json !== null) {
        emitJsonError(ctx.stdout, json, block);
        return;
    }
    writeLines(ctx.stderr, [...lead, ...renderErrorBlock(block, ctx.colour)]);
}
/**
 * `NOT_A_REPO` — the one block `why`, `report` and `finalize` share. Names the folder (tilde, cut from the LEFT so the
 * end that identifies it stays, §13.4) and says where to run it; there is no command to type, so the fix is a label.
 */
export function notAGitRepoBlock(ctx) {
    return {
        kind: "bad",
        code: "NOT_A_REPO",
        what: ERRORS.notAGitRepo,
        why: [ERRORS.notAGitRepoWhy(truncatePath(tildePath(ctx.cwd, ctx.home), 40))],
        fixLabel: ERRORS.notAGitRepoFix,
    };
}
//# sourceMappingURL=context.js.map