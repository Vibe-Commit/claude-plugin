/**
 * The exit-code contract — CR-022.
 *
 * The contract is SPLIT, and the split is load-bearing (D61 round 3 §D8). As
 * originally written the exit-0/stdout-empty rule governed the whole binary,
 * which would have made `why` on a read-lane 5xx exit 0 and print nothing —
 * a read verb failing silently.
 *
 * - HOOK invocations: always exit 0, always silent on stdout. Capture must never
 *   block or slow a developer's turn (D56 plan §D8, a founder override). A hook
 *   that exits non-zero or writes to stdout is a defect regardless of what went
 *   wrong underneath.
 * - INTERACTIVE verbs (`connect`, `status`, `off`, `why`, `report`): normal CLI
 *   semantics. Non-zero on failure, diagnostics on stderr, output on stdout.
 */
export const EXIT = {
    ok: 0,
    /** Interactive-only. A hook must never return this. */
    failure: 1,
    /**
     * Interactive-only. Usage error — unknown verb, bad flag, **or consent
     * requested on a non-TTY** (DESIGN.md §13.7, D65 plan §DR7). A consent prompt
     * that proceeds when nobody can answer it is not a consent prompt.
     */
    usage: 2,
    /**
     * Interactive-only. Not connected — distinct from `failure` so a wrapper can
     * branch on it without parsing copy (DESIGN.md §13.7).
     */
    notConnected: 3,
    /**
     * Interactive-only. Connected, nothing to report — the empty window.
     * **Not an error** (DESIGN.md §13.7, and it is load-bearing): collapsing an
     * empty `report` window or a pre-install `why` into `1` teaches a wrapper that
     * absence of a record means the tool broke — one `||` away from the
     * permanently BLOCKED claim that absence of an edge means no agent was
     * involved.
     */
    empty: 4,
};
/**
 * Resolve the exit code for a completed invocation.
 * Hooks collapse every outcome to 0 by contract; interactive verbs pass through.
 */
export function resolveExitCode(mode, outcome) {
    return mode === "hook" ? EXIT.ok : outcome;
}
/**
 * The hook-side half of the contract, stated as data so the contract test can
 * enumerate it rather than restate it (DESIGN.md §13.7).
 *
 * `stdout` is "empty on the happy path, otherwise exactly one well-formed JSON
 * object carrying `systemMessage`. If JSON construction fails for ANY reason →
 * empty stdout. The fallback is always silence."
 */
export const HOOK_CONTRACT = {
    exit: EXIT.ok,
    stderrBytes: 0,
};
//# sourceMappingURL=exit.js.map