/**
 * COMMIT-EDGE: WHICH REQUEST OF A DELIVERY CARRIES A COMMIT (P1's ruling on #117, after the multi-chunk probes).
 *
 * A delivery can span several requests (chunks): a backlog after a held 403, a first firing on a session that already has turns, a big turn. `x-commits` used to
 * ride only the LAST one, so a commit from an earlier turn arrived on a request whose capture starts at a later turn, and the server (which places a commit by
 * position or time RELATIVE TO THE REQUEST'S OWN CAPTURE) put it in the wrong turn. The rule now:
 *
 *   1. A commit line rides the FIRST request of its delivery whose span reaches the line's transcript position (`span.to >= observedPos`).
 *   2. A line with no position but a TIME (an older `post-commit`, or a failed position read) rides the first request whose last timestamped record is at or after
 *      it (the dialect's `recordTimeMs`; Cursor has none). A line with neither rides the LAST request, as it always did. So does a line whose position is
 *      past the end of the file.
 *   3. The last request carries everything still in the spool. `final`, the head and the rewrites stay on it alone.
 *   4. A request that carries lines settles exactly those lines (`settleSpooledLines`), and a line the server asks to keep (`X-Commits-Retry`, or "nothing
 *      landed") stays in the spool, so it rides the next request of the same delivery.
 *
 * What one request carried need NOT be a prefix of the spool: a position-less line ahead of a positioned one rides the last request while the positioned one
 * rides an earlier one. Hence the set-based settle, not "drop the first N".
 *
 * Pure: no file, no clock.
 */
/**
 * The commits an early request carries: the wire entries whose recorded position is at or before this span's end. `null` when it carries none, when
 * the spool read has no line map (a hand-built `Observed`), or when positions mean nothing for this delta (`resynced`: the file was replaced).
 * A held (non-wire) line carries no data and rides along with the first request that settles anything, so it drains.
 */
export function earlyCarry(commits, span, resynced, 
/**
 * The time of the LAST timestamped record in this request's body (the dialect's `recordTimeMs`), or `null` when it has none. Called at most once, and only when
 * a line has a time and no position: a line whose position is unknown but whose time is known rides the first request whose records reach that time.
 */
lastRecordMs = () => null) {
    if (commits === undefined)
        return null;
    const { lineOf, observedPos } = commits;
    if (lineOf === undefined || observedPos === undefined || lineOf.length !== commits.shas.length || observedPos.length !== commits.shas.length)
        return null;
    const observedAts = commits.observedAts;
    const picked = [];
    let reached; // undefined: not read yet
    for (let j = 0; j < commits.shas.length; j += 1) {
        const pos = observedPos[j];
        if (pos !== null && pos !== undefined) {
            // A position names a place in THIS file: meaningless when the delta restarted from 0 because the file was replaced.
            if (!resynced && Number.isSafeInteger(pos) && pos >= 0 && pos <= span.to)
                picked.push(j);
            continue;
        }
        const at = observedAts?.[j];
        if (at === null || at === undefined || !Number.isFinite(at))
            continue; // neither field: the last request, as today
        reached ??= lastRecordMs();
        if (reached !== null && reached >= at)
            picked.push(j);
    }
    if (picked.length === 0)
        return null;
    const wire = new Set(lineOf);
    const consume = new Set(picked.map((j) => lineOf[j]));
    for (let line = 0; line < commits.count; line += 1)
        if (!wire.has(line))
            consume.add(line);
    const pick = (list) => (list === undefined ? undefined : picked.map((j) => list[j]));
    const subset = {
        shas: picked.map((j) => commits.shas[j]),
        attributions: picked.map((j) => commits.attributions[j]),
        files: picked.map((j) => commits.files[j]),
        ...(commits.observedAts === undefined ? {} : { observedAts: pick(commits.observedAts) }),
        observedPos: pick(observedPos),
        lineOf: picked.map((j) => lineOf[j]),
        count: consume.size,
    };
    return { commits: subset, consume };
}
/**
 * Split a set of union line indices across the spool sources in the order they were concatenated (`SpoolSources.commits`): for each source, its LOCAL indices.
 * A source with none is omitted. Pure.
 */
export function splitConsume(sources, consume) {
    const out = [];
    let offset = 0;
    for (const source of sources) {
        const local = new Set();
        for (const line of consume)
            if (line >= offset && line < offset + source.count)
                local.add(line - offset);
        if (local.size > 0)
            out.push({ repoKey: source.repoKey, local });
        offset += source.count;
    }
    return out;
}
/**
 * The time of the LAST timestamped record in a request's body, through the dialect's `recordTimeMs`, or `null`. Scans back from the end, at most `maxLines`
 * non-empty lines (a withheld record is a same-length line that may not parse; an unterminated trailing line may not either: both are skipped). Never throws.
 */
export function lastRecordTimeMs(dialect, body, maxLines = 64) {
    const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    let end = buf.length;
    let seen = 0;
    while (end > 0 && seen < maxLines) {
        const start = buf.lastIndexOf(0x0a, end - 1) + 1; // the line is [start, end)
        const line = buf.subarray(start, end);
        end = start - 1;
        if (line.length === 0 || line.every((byte) => byte === 0x20 || byte === 0x0d))
            continue;
        seen += 1;
        try {
            const ms = dialect.recordTimeMs(JSON.parse(line.toString("utf8")));
            if (ms !== null)
                return ms;
        }
        catch {
            /* not JSON: skip it */
        }
    }
    return null;
}
//# sourceMappingURL=commit_carry.js.map