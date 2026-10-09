/**
 * `vibecommit status` and `vibecommit off` — the screen, `CR-021`.
 *
 * Style guide §10.3 draws it and D65 makes that drawing the ruling, so this
 * module renders it rather than designing it: four questions in fixed order
 * (on for *this* repo? last successful send? where do I look? what do I type to
 * fix it?), then the revoke link, on §13.5's `LABEL_GUTTER`.
 *
 * ## What is deliberately NOT on the screen
 *
 * §10.3's `last sent` row reads `4 minutes ago · 3 turns · seq 41`. **The turn
 * count is not rendered and must not be.** Counting turns means parsing the
 * transcript's NDJSON and deciding what a turn is, and that is the analysis the
 * client is barred from holding — D60 §D6: *the client may render; it may not
 * analyze, hash, or canonicalize*. The one recorded deviation is `CR-024d`'s
 * redaction parse, authorised by name; there is no such authorisation here, and
 * the server is the only thing holding sealed turns to count. The age and the
 * `seq` are both facts this client already wrote down, so both render.
 *
 * ## Absence is not a blank
 *
 * When nothing has been delivered for this repo the row is OMITTED and
 * `STATUS.neverSent` says so in a sentence. No sixth absence phrasing is
 * invented here: `CR-112` (W8) owns the five-absence grammar as one set, and
 * adding a variant now is what that task exists to prevent.
 */
import { COMMANDS, CREDENTIAL, ERRORS, HELP, OFF, STATUS, URLS, relativeAge } from "../copy/index.js";
import { isProjectAllowed, revokeProject } from "../consent.js";
import { loadCredential, savedCredentialExists } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { emitJson } from "../json.js";
import { readInferredSkipped } from "../inferred_tally.js";
import { readPruneTally } from "../pending_prune.js";
import { resolveProjectKeys } from "../project.js";
import { commitsWaitingForRepo, heldAtEndForRepo, inferredUnacknowledgedForRepo, lastReceiptForRepo, lastSendForRepo, leanHeldForRepo, leanSessionsForRepo, openTailForRepo, stuckForRepo, stuckSpoolLinesForRepo, writtenOffForRepo, } from "../state.js";
import { LABEL_GUTTER, WRAP_COLUMNS, glyph, labelled, paint, renderErrorBlock, tildePath, truncatePath, wrap, } from "../term.js";
import { writeLines } from "./context.js";
/** §10.3 indents the gutter rows four columns under the state line. */
const ROW_INDENT = 4;
export function status(ctx, argv = []) {
    // `TODOS[184]`. Check-first, before any git/credential/consent resolution — same ordering principle
    // every other verb's `--help` check uses. Reads and writes nothing.
    if (argv.includes("--help") || argv.includes("-h")) {
        writeLines(ctx.stdout, [HELP.commands.status]);
        return EXIT.ok;
    }
    // ⛔ THIS SCREEN USES BOTH ROLES AT ONCE (`D184 §1`), which is why the whole
    // function is not flipped: `on` below is CONSENT STATE and keys on the git
    // common dir, while the repo row, the send scan and the `--json` document are
    // REPO IDENTITY and stay on the worktree toplevel. The `--json` field is
    // literally named `toplevel`, so moving it would make the document lie.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    const projectKey = keys.worktree;
    // ⛔ CONSENT STATE, on the common dir. A worktree of a consented clone must
    // report ON here, because the hook that runs there is now admitted — a
    // `status` still keyed on the toplevel would tell that user they are
    // disconnected while their session was being captured.
    const on = isProjectAllowed(ctx.home, keys.consent);
    // ⛔ `ok` IS A HEALTH CLAIM, NOT ONLY A CONSENT ONE (`CR-228`, `TODOS[142]`).
    // The line beside the glyph is consent state and stays so; the glyph is what a
    // user reads as "fine". It printed `ok` over a session that had written off
    // 323,147 bytes, beside "No session has been recorded yet." — a sentence a
    // freshly connected repo prints too, so it told the user nothing. And a repo
    // that delivered SOMETHING first prints a `last sent` age instead: no hint at
    // all (VD). So the loss is reported as a byte count, which day one cannot
    // produce. Repo identity, like the send scan below, so the worktree toplevel.
    const writtenOff = writtenOffForRepo(ctx.home, projectKey);
    // ⛔ AND A HOLD AT `SessionEnd` IS NOT `ok` EITHER (`CR-228` part 1). Without
    // this line the fix would only move the failure: Gate A's session now ends
    // with `gapCount: 0` and its bytes HELD, and a glyph that read only the gap
    // counter would print `ok` over it again — the same defect with a longer fuse.
    const heldAtEnd = heldAtEndForRepo(ctx.home, projectKey);
    // ⭐ `TODOS[145]`/`[146]` — AND A SESSION THAT ENDED WITH ITS LAST TURN OPEN, when that costs something.
    // The delivery "succeeded" (nothing is held, nothing is written off), the server accepted every byte, and
    // nothing can ever bind: the glyph used to read `ok` over exactly that. Only the two losses are raised (a
    // one-shot session that sealed nothing, or commits still waiting) — see `openTailForRepo`.
    const openTail = openTailForRepo(ctx.home, projectKey, ctx.now().getTime());
    const waiting = commitsWaitingForRepo(ctx.home, projectKey, ctx.now().getTime());
    // `TODOS[175]`: counts of orphan waiting lines discarded in the last 7 days (null = none).
    const discarded = readPruneTally(ctx.home, projectKey, ctx.now().getTime());
    // `TODOS[177]`: squashes made by `git reset --soft` that were detected but could not be linked (null = none in the last 7 days).
    const inferredSkipped = readInferredSkipped(ctx.home, projectKey, ctx.now().getTime());
    // `TODOS[177]` follow-up: inferred pairs spooled right now, waiting on an ack that has not (yet) confirmed them.
    const inferredUnacknowledged = inferredUnacknowledgedForRepo(ctx.home, projectKey);
    // ⛔ NO `inferredSetAsideForRepo` LIVE GAUGE HERE (VL, 2026-10-08, VG's double-count finding, item (b)): it read
    // the SAME information `inferred_skipped.set_aside` already tallies durably, producing two JSON keys and two
    // sentences for one event. The tally is the ONE source of truth now; `inferredUnacknowledged` above stays,
    // since "still waiting" and "the server gave up" are two different facts.
    // `TODOS[182]`: commits/rewrites/inferred pairs held back right now because a session went `lean`, broken
    // out by kind — VG's B1/VL's V3 ruling is that this is the ONLY place they are counted: `waiting`/
    // `inferredUnacknowledged` above already exclude a lean session's data entirely (`commitsWaitingForRepo`/
    // `inferredUnacknowledgedForRepo`'s own docblocks), so there is no double-count to guard against here. A
    // live gauge is correct — nothing deletes `.spool.jsonl`/`.rewrites.jsonl` while unresolved
    // (`leanHeldForRepo`'s own docblock), so there is no file for a durable tally to outlive.
    const leanHeld = leanHeldForRepo(ctx.home, projectKey);
    const leanHeldTotal = leanHeld.commits + leanHeld.rewrites + leanHeld.inferred;
    // `TODOS[184]`: bytes stuck in a live session's backlog, or a session nobody has retried in a while —
    // the gap VL's original report named (`ok` plus total silence over real held data). Byte-range
    // partition (VG's D1), never `endedAt` — see `stuckForRepo`'s own docblock.
    const nowMs = ctx.now().getTime();
    const stuck = stuckForRepo(ctx.home, projectKey, nowMs);
    const leanSessions = leanSessionsForRepo(ctx.home, projectKey);
    // `TODOS[184]` (VG's S8 fix): the subset of `commitsWaitingForRepo`'s own count that belongs to a
    // stuck session. Named inside `liveStuck`/`heldIdle`'s own sentence instead, below — never double
    // counted, never touching `commitsWaitingForRepo` or its JSON number.
    const stuckSpoolLines = stuckSpoolLinesForRepo(ctx.home, projectKey, nowMs);
    const receipt = lastReceiptForRepo(ctx.home, projectKey);
    const kind = on &&
        writtenOff.gaps === 0 &&
        heldAtEnd.bytes === 0 &&
        openTail.ids.length === 0 &&
        leanHeldTotal === 0 &&
        stuck.liveStuck.bytes === 0 &&
        stuck.heldIdle.bytes === 0
        ? "ok"
        : "warn";
    const lines = [
        `  ${paint(ctx.colour, kind, glyph(ctx.colour, kind))} ${paint(ctx.colour, "strong", on ? STATUS.onForRepo : STATUS.offForRepo)}`,
        labelled(ROW_INDENT, STATUS.repoLabel, repoValue(ctx, projectKey)),
    ];
    // Question 2: the last successful send FOR THIS REPO. `status` has no
    // session_id — it is interactive — so this is a scan of the repo's session
    // files rather than a lookup (`lastSendForRepo`).
    const lastSend = lastSendForRepo(ctx.home, projectKey);
    if (lastSend !== null) {
        lines.push(labelled(ROW_INDENT, STATUS.lastSuccessLabel, STATUS.lastSuccessValue(relativeAge(lastSend.at, ctx.now().getTime()), lastSend.seq)));
    }
    lines.push(labelled(ROW_INDENT, STATUS.dashboardLabel, paint(ctx.colour, "accent", URLS.dashboard)));
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    // §13.3 — `--json` emits NOTHING BUT the JSON document on stdout, so the
    // screen assembled above is DISCARDED rather than printed beside it.
    //
    // The credential fault below still refuses, and it refuses the same way it
    // does in prose: §13.6's block to stderr, nothing on stdout, exit 1. A failure
    // is not an answer, so it gets no document — `src/json.ts`'s docblock states
    // that split and why it is a builder's reading of §13.3 rather than a ruling.
    //
    // ⚠ `last_send` is `null` when nothing has been delivered, never a zeroed
    // object: absence here is *nothing has been sent*, and a `{ at_ms: 0 }` would
    // be a timestamp claim. §13.2's glyph rule has no glyph on this surface, so
    // `outcome` carries the on/off distinction the glyph carries on screen.
    if (argv.includes("--json")) {
        if (load.kind !== "ok" && load.kind !== "absent") {
            writeLines(ctx.stderr, credentialProblem(load, ctx.colour));
            return EXIT.failure;
        }
        emitJson(ctx.stdout, "status", on ? "on" : "off", {
            repo: resolveRepoSlug(projectKey),
            toplevel: projectKey,
            last_send: lastSend === null ? null : { at_ms: lastSend.at, seq: lastSend.seq },
            dashboard: URLS.dashboard,
            // `CR-216/U3`. A SOURCE NAME, never the credential — `IngestCredential.source`
            // is documented safe to log for exactly this. `null` is "no credential",
            // which is a different answer from either source and must not collapse into
            // one. D98 detection 3 holds the key set; this key is a contract change and
            // `json-read-verbs.test.ts` records it as one.
            credential: load.kind === "ok" ? load.credential.source : null,
            // `CR-228`. Always an object, zeros included: unlike `last_send`, "nothing
            // written off" is a measured answer and not an absence. ⛔ A contract
            // change, recorded in `json-read-verbs.test.ts` beside `credential`'s.
            written_off: {
                bytes: writtenOff.bytes,
                gaps: writtenOff.gaps,
                sessions: writtenOff.sessions,
            },
            held_at_end: { bytes: heldAtEnd.bytes, sessions: heldAtEnd.sessions },
            // `TODOS[145]`/`[146]`. `last_receipt.sealed` is `true` (the newest delivery sealed a capture), `false`
            // (it sealed nothing) or `null` (an older server sent no receipt); the whole key is `null` when nothing
            // has been delivered. ⛔ A contract change, recorded in `json-read-verbs.test.ts`.
            last_receipt: receipt === null ? null : { at_ms: receipt.at, sealed: receipt.sealed },
            commits_waiting: waiting,
            // `TODOS[175]`. Always an object, zeros included. ⛔ A contract change, recorded in `json-read-verbs.test.ts`.
            discarded_stale: { lines: discarded?.lines ?? 0, files: discarded?.files ?? 0 },
            inferred_skipped: {
                oversize: inferredSkipped?.oversize ?? 0,
                sha256: inferredSkipped?.sha256 ?? 0,
                set_aside: inferredSkipped?.set_aside ?? 0,
                pruned: inferredSkipped?.pruned ?? 0,
            },
            inferred_unacknowledged: inferredUnacknowledged,
            // `TODOS[182]`. A single number — the sum of commits/rewrites/inferred pairs held back by `lean`
            // (`status`'s TEXT names the parts; the JSON contract stays one key). A contract change, recorded in
            // `json-read-verbs.test.ts`.
            lean_held: leanHeldTotal,
            open_tail: { sessions: openTail.ids.length, ids: openTail.ids },
            // `TODOS[184]`. Additive — always objects, zeros included, same precedent as `held_at_end`/
            // `written_off`. `commits_waiting` above is UNTOUCHED: it is still `commitsWaitingForRepo`'s own
            // number, never reduced for a stuck session's lines (those are named in the TEXT only, §3's note).
            live_stuck: { bytes: stuck.liveStuck.bytes, sessions: stuck.liveStuck.sessions },
            held_idle: { bytes: stuck.heldIdle.bytes, sessions: stuck.heldIdle.sessions },
            lean_sessions: leanSessions,
        });
        return on ? EXIT.ok : EXIT.notConnected;
    }
    if (load.kind !== "ok" && load.kind !== "absent") {
        writeLines(ctx.stdout, lines);
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour));
        return EXIT.failure;
    }
    // `TODOS[184]` (VL's D4 ruling): built once, placed in one of two spots below depending on whether
    // `neverSent` prints. Each line also names the stuck-session subset of `commitsWaitingForRepo`'s count
    // (VG's S8 fix) — `stuckCommitsTotal` below is subtracted from `waiting` for `commitsWaiting`'s own
    // sentence so neither double-counts the other.
    const stuckLines = [];
    if (stuck.liveStuck.bytes > 0) {
        stuckLines.push("", ...wrap(STATUS.liveStuck(stuck.liveStuck.bytes, stuck.liveStuck.sessions, stuckSpoolLines.liveCommits, stuck.liveStuck.ids), 2));
    }
    if (stuck.heldIdle.bytes > 0) {
        stuckLines.push("", ...wrap(STATUS.heldIdle(stuck.heldIdle.bytes, stuck.heldIdle.sessions, stuckSpoolLines.idleCommits, stuck.heldIdle.ids), 2));
    }
    const stuckCommitsTotal = stuckSpoolLines.liveCommits + stuckSpoolLines.idleCommits;
    // Absence is a SENTENCE, not a blank row. Triggered on the send record rather
    // than on the credential: a repo that has delivered and then lost its
    // credential has still recorded a session, and saying otherwise would be false.
    if (on && lastSend === null) {
        lines.push("", ...wrap(STATUS.neverSent, 2));
        // `TODOS[184]` (D4): immediately after `neverSent`, same precedent `writtenOff` already follows it by.
        lines.push(...stuckLines);
    }
    // `CR-228`. After `neverSent`, deliberately: in the measured failure both are
    // true at once, and "nothing recorded" followed by why is the order that reads
    // as one account. Shown OFF as well — consent withdrawn later does not undo a
    // loss that happened while it was on.
    if (writtenOff.gaps > 0) {
        lines.push("", ...wrap(STATUS.writtenOff(writtenOff.bytes, writtenOff.sessions), 2));
    }
    if (heldAtEnd.bytes > 0) {
        lines.push("", ...wrap(STATUS.heldAtEnd(heldAtEnd.bytes, heldAtEnd.sessions), 2));
    }
    // `TODOS[184]` (D4): the delivery-health group's own slot, right after `heldAtEnd` — but only here when
    // `neverSent` did NOT already print it above.
    if (!(on && lastSend === null)) {
        lines.push(...stuckLines);
    }
    // `TODOS[145]`/`[146]`: the consequence first (a session is over and its last turn never closed), then the
    // neutral fact (commits are waiting for a turn). Both omitted when zero — absence here is the healthy case.
    if (openTail.ids.length > 0) {
        lines.push("", ...wrap(STATUS.openTail(openTail.ids.length), 2));
    }
    else if (waiting - stuckCommitsTotal > 0) {
        lines.push("", ...wrap(STATUS.commitsWaiting(waiting - stuckCommitsTotal), 2));
    }
    if (inferredSkipped !== null) {
        lines.push("", ...wrap(STATUS.inferredSkipped(inferredSkipped.oversize, inferredSkipped.sha256, inferredSkipped.set_aside, inferredSkipped.pruned), 2));
    }
    if (inferredUnacknowledged > 0) {
        lines.push("", ...wrap(STATUS.inferredUnacknowledged(inferredUnacknowledged), 2));
    }
    if (leanHeldTotal > 0) {
        lines.push("", ...wrap(STATUS.leanHeld(leanHeld.commits, leanHeld.rewrites, leanHeld.inferred), 2));
    }
    if (discarded !== null && discarded.lines > 0) {
        lines.push("", ...wrap(STATUS.discardedStale(discarded.lines), 2));
    }
    // `CR-216/U3`. Same precedent as `neverSent` above: a SENTENCE, not a fifth
    // gutter row — §10.3 draws four questions in a fixed order and the order is the
    // feature. Only when the env var is actually overriding something: CI sets the
    // variable deliberately with no file to shadow and must not be nagged for it.
    if (load.kind === "ok" && load.credential.source === "env" && savedCredentialExists(ctx.home)) {
        lines.push("", ...wrap(STATUS.credentialShadowed, 2));
    }
    lines.push("", ...actionLines(ctx, on));
    writeLines(ctx.stdout, lines);
    return on ? EXIT.ok : EXIT.notConnected;
}
/**
 * §10.3's repo row: `owner/name (git toplevel ~/path)`.
 *
 * The slug is `CR-019d`'s — the same value that goes on the wire as
 * `X-Repo-Slug` — so what `status` shows is what the server will resolve, which
 * is the point of `status` being the debugging tool (D57 §DX1). A repo with no
 * GitHub remote shows its `local:` identity rather than hiding it: that IS the
 * answer to "why does the dashboard not show my repo under its name?".
 *
 * The path is truncated from the LEFT (§13.4) against what the line actually has
 * left, not a fixed 60, so the row cannot exceed 80 columns for a long slug.
 */
function repoValue(ctx, toplevel) {
    const slug = resolveRepoSlug(toplevel);
    const shown = tildePath(toplevel, ctx.home);
    const overhead = ROW_INDENT + LABEL_GUTTER + STATUS.repoToplevel(slug, "").length;
    let budget = Math.max(12, WRAP_COLUMNS - overhead);
    let value = STATUS.repoToplevel(slug, truncatePath(shown, budget));
    // Fit the row by BYTES as well as by columns, and pay the difference only on
    // rows that actually truncate. `truncatePath`'s `…` is one column but three
    // UTF-8 bytes, so a row filled to exactly 80 columns is 82 bytes — which
    // passes §13.4 (a terminal renders one column) and fails the byte-counting
    // `awk` check the verify recipe uses. BSD awk counts bytes whatever the
    // locale, so satisfying the stricter measure is cheaper than arguing about
    // which one is right: it costs at most two columns, and only here.
    while (ROW_INDENT + LABEL_GUTTER + Buffer.byteLength(value) > WRAP_COLUMNS && budget > 12) {
        budget -= 1;
        value = STATUS.repoToplevel(slug, truncatePath(shown, budget));
    }
    return value;
}
/**
 * The two trailing actions, aligned as one pair — §10.3 draws their values in a
 * shared column, which only holds if both labels pad to the longer of the two.
 *
 * When capture is OFF the first line is the reconnect command instead: there is
 * nothing to turn off, and §10.3 only draws the on-state.
 */
function actionLines(ctx, on) {
    const pairs = on
        ? [
            [STATUS.turnOffLabel, COMMANDS.off],
            [STATUS.revokeLabel, URLS.settings],
        ]
        : [
            [STATUS.fixCommandLabel, COMMANDS.connect],
            [STATUS.revokeLabel, URLS.settings],
        ];
    const width = Math.max(...pairs.map(([label]) => label.length));
    return pairs.map(([label, value]) => {
        const painted = value.startsWith("https://") ? paint(ctx.colour, "accent", value) : value;
        return `  ${`${label}:`.padEnd(width + 2)}${painted}`;
    });
}
/**
 * `TODOS[184]` (VG's F1, VL's ruling): `off`'s own mirror of `index.ts`'s `--no-color` argv parse —
 * that call site (`argv.includes("--no-color")`, feeding `resolveColour`) is the authority this list
 * copies; it does not import a shared constant from `term.ts`, because `index.ts` ties "is this a
 * global flag" to "turn colour off" for every future entry there, and `off` must not inherit that
 * coupling. If a second global flag is ever added at `index.ts`'s site, add it here too.
 */
const OFF_RECOGNIZED_GLOBAL_FLAGS = ["--no-color"];
export function off(ctx, argv = []) {
    // `TODOS[184]`. `off` used to take no `argv` at all, so EVERY trailing token — including `--help`
    // landing here by accident — silently revoked consent (measured on 0.4.3 and 0.4.4 alike). `--help`/
    // `-h` print help and change nothing; any other argument is refused the same way, also changing
    // nothing — a revoke must never run on an argument this verb did not parse.
    if (argv.includes("--help") || argv.includes("-h")) {
        writeLines(ctx.stdout, [HELP.commands.off]);
        return EXIT.ok;
    }
    // `--no-color` is a global flag 0.4.4's `off` (which parsed no argv at all) tolerated by construction;
    // every OTHER argument (including `--json`, which `off` has no mode for) still refuses.
    const rest = argv.filter((arg) => !OFF_RECOGNIZED_GLOBAL_FLAGS.includes(arg));
    if (rest.length > 0) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: OFF.unrecognizedArgWhat, why: [OFF.unrecognizedArgWhy] }, ctx.colour));
        return EXIT.usage;
    }
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    // ⛔ THE REVOKE SIDE, AND IT MUST DELETE THE KEY `connect` WROTE (`D184 §9`).
    // `revokeProject` deletes by exact string and reports `false` when the key is
    // absent — so a revoke still keyed on the toplevel would find nothing, print
    // "already off", and LEAVE THE GRANT IN PLACE. The user believes they
    // withdrew consent; capture continues. That is the worse direction of this
    // same bug, and it is the second mutation the cells below pin.
    const changed = revokeProject(ctx.home, keys.consent);
    writeLines(ctx.stdout, [
        ...wrap(changed ? OFF.done : OFF.alreadyOff, 2),
        ...wrap(OFF.note, 2),
    ]);
    return EXIT.ok;
}
/**
 * The three credential problems that are worth four different fixes on an
 * interactive surface. The hook collapses them to one `systemMessage`; here the
 * user can act, so §13.6 gets its full what / why / fix.
 *
 * None of these lines can carry credential bytes: the plaintext leaves
 * `IngestCredential` only through `expose()`, and no copy path calls it.
 */
function credentialProblem(load, colour) {
    switch (load.kind) {
        case "wrong-class":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.wrongClassWhat,
                why: [
                    load.source === "env"
                        ? CREDENTIAL.wrongClassEnvWhy
                        : CREDENTIAL.wrongClassFileWhy,
                ],
                fixLabel: CREDENTIAL.wrongClassFix,
                fixes: [CREDENTIAL.wrongClassCommand],
            }, colour);
        case "insecure-file":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.insecureFileWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`,
                    CREDENTIAL.insecureFileWhy,
                ],
                fixLabel: CREDENTIAL.insecureFileFix,
                fixes: [COMMANDS.chmodCredentials],
            }, colour);
        case "unreadable":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.unreadableWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    CREDENTIAL.unreadableWhy,
                ],
                fixLabel: CREDENTIAL.unreadableFix,
                fixes: [CREDENTIAL.unreadableCommand],
            }, colour);
    }
}
//# sourceMappingURL=status.js.map