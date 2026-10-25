/**
 * `vibecommit status` from a folder that is not a git work tree — the MACHINE-level screen (0.7.0, design review D6 · 2A).
 *
 * Inside a repo `status` answers about that repo (§10.3). From anywhere else there is no repo to be about, and the old
 * answer — "Not a git repository" — was the very precondition 0.7.0 removes from `connect`. So it answers for the machine:
 * what is on, what is turned off, when anything last sent, where the dashboard is, and the three things to do next.
 *
 * Reads `grants.json`, `grants-account.json`, `projects.json` and session state; opens no transcript, makes no request and
 * writes nothing — the one bounded account sync (slice 2) is `statusVerb`'s, which runs before this and hands in its outcome.
 * It spawns one `git remote get-url` per per-clone consent (to count them as repos), and nothing else.
 *
 * ⚠ **`last sent` names no repo.** The drawn screen says `4 minutes ago · alexvibecommit/example-repo`, but session state
 * is kept under a one-way digest of the repo's path, so the machine-wide scan can say WHEN and not WHICH. Naming the repo
 * needs the digest inverted or a slug recorded beside it — a state-format change for another PR, reported to the design.
 * ⚠ **`owners` rows carry no clone count** ("3 clones here"): counting them is a filesystem scan (`scan`'s 2-3 s on a
 * heavy machine), which `status` must not pay. The row says what is true without one: later clones are covered.
 */
import { EXIT } from "../exit.js";
import { AGENT_HOOKS, COMMANDS, PICKER, STATUS, URLS, relativeAge } from "../copy/index.js";
import { emitJson } from "../json.js";
import { credentialProblemBlock } from "./credential_problem.js";
import { authCommandFor, channelCommand } from "../install.js";
import { loadCredential } from "../credential.js";
import { machineCapture, machineSummary } from "../machine_state.js";
import { isLocalSlug, normalizeSlug, ownerOfSlug } from "../consent.js";
import { listOrgPending } from "../org_pending.js";
import { lastSendOnMachine } from "../state.js";
import { LABEL_GUTTER, WRAP_COLUMNS, glyph, labelled, paint, wrap } from "../term.js";
import { writeFailure, writeLines } from "./context.js";
import { readAccountView } from "../grants_verb.js";
/** §10.3 indents the gutter rows four columns under the state line. */
const ROW_INDENT = 4;
/** `rows` on the label gutter: the first carries the label, the rest hang under it. Values wrap at 80 columns. */
function rows(label, values) {
    if (values.length === 0)
        return [];
    const out = [];
    let line = "";
    const flush = () => {
        out.push(out.length === 0 ? labelled(ROW_INDENT, label, line) : `${" ".repeat(ROW_INDENT + LABEL_GUTTER)}${line}`);
        line = "";
    };
    for (const [i, value] of values.entries()) {
        const piece = i === 0 || line === "" ? value : `, ${value}`;
        if (line !== "" && ROW_INDENT + LABEL_GUTTER + line.length + piece.length > WRAP_COLUMNS) {
            flush();
            line = value;
        }
        else
            line += piece;
    }
    flush();
    return out;
}
/** A labelled row whose VALUE is a sentence: wrapped at 80 columns, the continuation hanging under the value. */
function sentenceRow(label, text) {
    const hang = ROW_INDENT + LABEL_GUTTER;
    const lines = wrap(text, hang);
    return lines.map((line, i) => (i === 0 ? labelled(ROW_INDENT, label, line.slice(hang)) : line));
}
/**
 * Slice 2 (S4), brief §3.3: what the user's account grants that this machine has not named, and the changes queued for it.
 * Between `off` and `held`; and on a machine that names nothing, right under the heading.
 */
function accountRows(ctx, view) {
    const out = [];
    if (view.notHere.length > 0) {
        out.push(...rows(STATUS.accountLabel, view.notHere));
        out.push(...wrap(STATUS.accountNotHere(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), ROW_INDENT + LABEL_GUTTER));
    }
    const retrying = view.pending - view.pendingRejected;
    if (view.pendingRejected > 0)
        out.push(...sentenceRow(STATUS.pendingLabel, STATUS.pendingRejectedValue(view.pendingRejected)));
    if (retrying > 0)
        out.push(...sentenceRow(view.pendingRejected > 0 ? "" : STATUS.pendingLabel, STATUS.pendingValue(retrying)));
    return out;
}
/**
 * "0.8.0 truth fixes" F6: the same `on account` and `pending` rows, for the screen of a repo. They are about the machine and the
 * account, not the repo, but they are what notice 10, `connect`'s "They stay granted on your account" and the README say `status`
 * lists, and a person reads `status` from inside a clone. Empty when there is nothing to say (or `grants.json` is unreadable).
 * Text only: the in-repo `--json` document is unchanged.
 */
export function accountRowsFor(ctx, sync) {
    const capture = machineCapture(ctx.home);
    if (capture.kind === "unreadable")
        return [];
    const view = readAccountView(ctx.home, capture.kind === "on" ? capture.perClone.flatMap((c) => (c.slug === null ? [] : [normalizeSlug(c.slug)])) : [], sync);
    return view === null ? [] : accountRows(ctx, view);
}
/**
 * The repos waiting on an organization's approval: every standing marker in `org_pending.ts`'s slug directory (written when
 * THAT repo's own upload got `403 capture_not_approved`, cleared by a 2xx from ANY clone of it), reduced by VT's conditions.
 * (i) Only a slug still ON under the current grants and exclusions — a repo turned off, or no longer granted, is not "waiting".
 * (ii) Deduped by slug (one file per slug already; kept defensively). (iii) A marker with no slug is skipped, never an unnamed
 * row. A `local:` slug names a path and cannot belong to an organization.
 */
function waitingRepos(ctx, capture) {
    const { grants } = capture;
    const perClone = new Set(capture.perClone.flatMap((c) => (c.slug === null ? [] : [normalizeSlug(c.slug)])));
    const waiting = new Set();
    for (const marker of listOrgPending(ctx.home)) {
        if (marker.slug === null)
            continue;
        const slug = normalizeSlug(marker.slug);
        if (isLocalSlug(slug) || grants.excluded.includes(slug))
            continue;
        if (grants.owners.includes(ownerOfSlug(slug)) || grants.repos.includes(slug) || perClone.has(slug))
            waiting.add(slug);
    }
    return [...waiting].sort();
}
export function machineStatus(ctx, argv, sync = { kind: "skipped" }) {
    const capture = machineCapture(ctx.home);
    // Slice 2 (S4). `null` when `grants.json` is unreadable: the pending queue is unknowable, so no account rows.
    const view = capture.kind === "unreadable"
        ? null
        : readAccountView(ctx.home, capture.kind === "on" ? capture.perClone.flatMap((c) => (c.slug === null ? [] : [normalizeSlug(c.slug)])) : [], sync);
    const waiting = capture.kind === "on" ? waitingRepos(ctx, capture) : [];
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    const last = lastSendOnMachine(ctx.home);
    const nowMs = ctx.now().getTime();
    if (argv.includes("--json")) {
        if (load.kind !== "ok" && load.kind !== "absent") {
            writeFailure(ctx, credentialProblemBlock(load, authCommandFor(ctx.env, ctx.selfPath)), "status");
            return EXIT.failure;
        }
        const on = capture.kind === "on";
        emitJson(ctx.stdout, "status", on ? "on" : "off", {
            scope: "machine",
            owners: on ? capture.grants.owners : [],
            repos: on ? capture.grants.repos : [],
            excluded: on ? capture.grants.excluded : [],
            per_clone: on ? capture.perClone.length : 0,
            // 0.7.0: the slugs whose own last upload was refused because their org has not approved capture (still on, deduped,
            // named). A machine key for the release paragraph; it does not change the exit code.
            org_pending: waiting,
            grants_unreadable: capture.kind === "unreadable",
            // Slice 2 (S4): the last synced account state (`null` before the first sync); what it grants that this machine has not
            // named (an owner as `owner/`); the changes queued for it; and how many of those the server refused in this run.
            account: view === null || view.account === null
                ? null
                : {
                    owners: view.account.owners,
                    repos: view.account.repos,
                    excluded: view.account.excluded,
                    epoch: view.account.epoch,
                    synced_at: view.account.synced_at,
                },
            account_not_here: view === null ? [] : view.notHere,
            pending: view === null ? 0 : view.pending,
            pending_rejected: view === null ? 0 : view.pendingRejected,
            last_send: last === null ? null : { at_ms: last.at, seq: last.seq },
            dashboard: URLS.dashboard,
            credential: load.kind === "ok" ? load.credential.source : null,
        });
        return on ? EXIT.ok : EXIT.notConnected;
    }
    // `ok` only when something is on; `warn` for "nothing is" and for an unreadable file (§13.2 glyph).
    const kind = capture.kind === "on" ? "ok" : "warn";
    const heading = capture.kind === "on" ? PICKER.onFor(machineSummary(capture)) : STATUS.offMachine;
    const lines = [`  ${paint(ctx.colour, kind, glyph(ctx.colour, kind))} ${paint(ctx.colour, "strong", heading)}`];
    if (capture.kind === "unreadable") {
        lines.push("", ...wrap(STATUS.grantsUnreadable(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2));
    }
    else if (capture.kind === "on") {
        const { grants } = capture;
        for (const [i, owner] of grants.owners.entries()) {
            lines.push(labelled(ROW_INDENT, i === 0 ? STATUS.ownersLabel : "", `${owner}/  ${STATUS.ownerTail}`));
        }
        const covered = (slug) => grants.owners.includes(ownerOfSlug(slug));
        const repos = [
            ...grants.repos.filter((r) => !grants.excluded.includes(r) && !covered(r)),
            ...capture.perClone
                .filter((c) => c.slug !== null && !grants.excluded.includes(c.slug.toLowerCase()) && !covered(c.slug.toLowerCase()))
                .map((c) => c.slug.toLowerCase()),
        ];
        lines.push(...rows(STATUS.reposLabel, [...new Set(repos)]));
        lines.push(...rows(STATUS.offLabel, grants.excluded));
        if (view !== null)
            lines.push(...accountRows(ctx, view));
        // §10.2's held vocabulary: the beat word and "the org must approve capture". One row, naming the repos; never an unnamed one.
        if (waiting.length > 0) {
            lines.push(...rows(STATUS.heldLabel, waiting), `${" ".repeat(ROW_INDENT + LABEL_GUTTER)}${STATUS.heldReason}`);
        }
    }
    // A machine that names nothing still shows what its account grants and what is queued, right under the heading.
    if (capture.kind === "none" && view !== null)
        lines.push(...accountRows(ctx, view));
    if (last !== null)
        lines.push(labelled(ROW_INDENT, STATUS.lastSuccessLabel, relativeAge(last.at, nowMs)));
    lines.push(labelled(ROW_INDENT, STATUS.dashboardLabel, paint(ctx.colour, "accent", URLS.dashboard)));
    // Codex runs no user-level hook until the user trusts it. Said, never detected (VQ + Alexander, 2026-10-24).
    if (capture.kind === "on")
        lines.push("", ...wrap(AGENT_HOOKS.codexTrust, 2));
    const pairs = [
        [STATUS.changeLabel, channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)],
        ...(capture.kind === "on" ? [[STATUS.turnOffInside, channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)]] : []),
        [STATUS.revokeLabel, URLS.settings],
    ];
    const width = Math.max(...pairs.map(([label]) => label.length));
    lines.push("", ...pairs.map(([label, value]) => {
        const painted = value.startsWith("https://") ? paint(ctx.colour, "accent", value) : value;
        return `  ${`${label}:`.padEnd(width + 2)}${painted}`;
    }));
    writeLines(ctx.stdout, lines);
    // Exit 3 when nothing is captured, as `status` in a repo that is off does — a wrapper can branch on it.
    return capture.kind === "on" ? EXIT.ok : EXIT.notConnected;
}
//# sourceMappingURL=status_machine.js.map