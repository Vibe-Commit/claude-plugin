/**
 * The one argument check for the verbs that read their own flags (cli-ux PR-A T22a; plan 4.11, DX-24, D-ARGS).
 *
 * Every verb in `CHECKED_VERBS` runs through `checkArgs` in `cli.ts`'s `main()`, after the credential check and before the
 * verb itself, so a refused argument reads nothing, asks nothing and makes no request. The table below is the ONLY list of
 * flags those verbs accept: `connect`'s did-you-mean line is built from it, and `test/args-check.test.ts` ties each row to
 * the help's option rows (`HELP.verbs[verb].options`).
 *
 * ⛔ NOT CHECKED, ON PURPOSE: the hidden verbs `hook`, `post-commit`, `post-rewrite` and `__upload-worker`, which `index.ts`
 * dispatches before `cli.ts` is loaded.
 */
import { INGEST_TOKEN_PREFIX } from "./credential.js";
/** The user verbs this check governs: PR-A's six, and PR-B's `status`, `off` and `backfill` (T22). */
export const CHECKED_VERBS = ["connect", "auth", "scan", "why", "finalize", "report", "status", "off", "backfill"];
export function isCheckedVerb(value) {
    return value !== undefined && CHECKED_VERBS.includes(value);
}
/** Accepted by every checked verb. `-h` and `--help` are the same screen; `--no-color` is the global flag. */
export const GLOBAL_FLAGS = ["--no-color", "--help", "-h"];
/**
 * What each verb accepts beyond `GLOBAL_FLAGS`. Rows here must match the verb's own option rows in `HELP.verbs`, with the
 * exceptions named in `test/verb-help.test.ts`.
 */
export const FLAG_TABLE = {
    connect: [
        { name: "--sign-in", value: false },
        { name: "--device", value: false },
        // T7 (4.9, B3): skips the earlier-sessions offer, its question and the test capture. A `connect` flag, never a "yes" (D65 §DR7).
        { name: "--no-backfill", value: false },
        { name: "--typed", value: false },
        { name: "--agent", value: true, equalsOnly: true },
    ],
    auth: [
        { name: "--stdin", value: false },
        { name: "--paste", value: false },
        { name: "--device", value: false },
    ],
    scan: [{ name: "--json", value: false }],
    why: [{ name: "--json", value: false }],
    finalize: [
        { name: "--session", value: true },
        { name: "--latest", value: false },
        { name: "--force", value: false },
    ],
    report: [
        { name: "--since", value: true },
        { name: "--ref", value: true },
        { name: "--json", value: false },
    ],
    status: [{ name: "--json", value: false }],
    off: [],
    backfill: [],
};
/**
 * What a bare (non-flag) token means to each verb:
 *   - `refuse`: it is an unknown argument (names do not exist in this build for `connect`, so it is refused like any other);
 *   - `auth-check`: `auth`'s own `CREDENTIAL_IN_ARGV` check owns it, and runs first (it is a credential, not a flag);
 *   - `target`: the verb reads it (`why`'s `<file>:<line>`, `off`'s `owner/repo`), and refuses a bad one itself.
 */
export const POSITIONALS = {
    connect: "target",
    auth: "auth-check",
    scan: "refuse",
    why: "target",
    finalize: "refuse",
    report: "refuse",
    status: "refuse",
    off: "target",
    backfill: "refuse",
};
/** The longest token the refusal names; longer ones are cut with an ellipsis (`unknownCommandWhat`'s rule). */
export const SHOWN_LENGTH = 40;
/** `a, b or c`: the registry's ids, named in their order, for a sentence. */
export function orList(items) {
    if (items.length <= 1)
        return items.join("");
    return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
/** A short Levenshtein distance; the inputs are flag names, so this stays tiny. */
function editDistance(a, b) {
    let row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
        const next = [i];
        for (let j = 1; j <= b.length; j += 1) {
            next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        }
        row = next;
    }
    return row[b.length];
}
/**
 * The nearest of `candidates` within edit distance 2; ties go to the alphabetically first. `connect` only (CEO-6).
 * The candidates are the check's own flag names, so a flag that does not exist is never offered (T7: `--no-backfill` is a flag of `connect`,
 * so it is a candidate, and `--no-backfil` gets it).
 */
export function nearestFlag(name, candidates) {
    let best = null;
    for (const flag of [...candidates].sort()) {
        const distance = editDistance(name, flag);
        if (distance <= 2 && (best === null || distance < best.distance))
            best = { flag, distance };
    }
    return best?.flag ?? null;
}
/**
 * FB1 (review finding 2, ENG-32): the prefix and everything after it, up to a separator (whitespace, a quote, or `>`), is never
 * printed. `vcik_<secret>` becomes `vcik_…`, and `acme/my_vcik_tool` becomes `acme/my_vcik_…`. The prefix comes from
 * `INGEST_TOKEN_PREFIX`, never a literal. Every echo of an argv token goes through here.
 */
const CREDENTIAL_RUN = new RegExp(`${INGEST_TOKEN_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s"'\`“”‘’«»>]*`, "g");
export function redactCredential(text) {
    return text.replace(CREDENTIAL_RUN, `${INGEST_TOKEN_PREFIX}…`);
}
/**
 * FD3(b): a token a suggested command may print unquoted. Anything else (whitespace, a quote, `$`, `;`, `|`, `&`, `>`, a backtick,
 * a redaction `…`) would be split or run by a shell when the person pastes the line.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9._/:=@+,-]+$/;
export function isShellSafeToken(token) {
    return SHELL_SAFE_TOKEN.test(token);
}
/** The text a refusal names: the token with any credential redacted, cut at `SHOWN_LENGTH`, and for `--flag=value` only `--flag=…`. */
export function shownToken(token) {
    const redacted = redactCredential(token);
    const eq = redacted.indexOf("=");
    const text = eq >= 0 ? `${redacted.slice(0, eq)}=…` : redacted;
    return text.length > SHOWN_LENGTH ? `${text.slice(0, SHOWN_LENGTH - 1)}…` : text;
}
/**
 * Check one verb's arguments (everything after the verb). Returns the first refusal, or null when every argument is one the verb
 * takes. `agentIds` is the registry's ids, passed in so this module stays free of the agent code.
 */
export function checkArgs(verb, args, agentIds) {
    const table = FLAG_TABLE[verb];
    // FB5 (review finding 12): `--agent` is never a candidate. It is read from its `=` form only, and a bare `--agent` is ARGUMENT_NEEDS_VALUE.
    const connectFlags = [...FLAG_TABLE.connect.map((spec) => spec.name).filter((name) => name !== "--agent"), "--help"];
    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (GLOBAL_FLAGS.includes(token))
            continue;
        if (!token.startsWith("-")) {
            if (POSITIONALS[verb] !== "refuse")
                continue;
            return { kind: "unrecognized", shown: shownToken(token), index: i, suggestion: null, accepted: null };
        }
        const eq = token.indexOf("=");
        const name = eq >= 0 ? token.slice(0, eq) : token;
        const spec = table.find((candidate) => candidate.name === name);
        if (spec === undefined) {
            const suggestion = verb === "connect" ? nearestFlag(name, connectFlags) : null;
            return { kind: "unrecognized", shown: shownToken(token), index: i, suggestion, accepted: null };
        }
        if (!spec.value) {
            if (eq >= 0)
                return { kind: "unrecognized", shown: shownToken(token), index: i, suggestion: null, accepted: null };
            continue;
        }
        if (eq >= 0) {
            const value = token.slice(eq + 1);
            if (value === "")
                return { kind: "needs-value", shown: name };
            if (name === "--agent") {
                if (agentIds.includes(value))
                    continue;
                // A known id that the value is a prefix of, and only one, is the did-you-mean (`codex` gives `codex-cli`).
                const matches = agentIds.filter((id) => id.startsWith(value));
                const suggestion = matches.length === 1 ? `--agent=${matches[0]}` : null;
                return { kind: "unrecognized", shown: shownToken(token), index: i, suggestion, accepted: agentIds };
            }
            continue;
        }
        if (spec.equalsOnly === true)
            return { kind: "needs-value", shown: name };
        const next = args[i + 1];
        if (next === undefined || next.startsWith("-"))
            return { kind: "needs-value", shown: name };
        i += 1;
    }
    return null;
}
//# sourceMappingURL=args.js.map