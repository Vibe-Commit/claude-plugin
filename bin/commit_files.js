/**
 * The changed-file list of the commits an upload reports, as a LENGTH-FRAMED TRAILER on the upload body
 * (transcript-view plan, E8 · design D6 / ER3; wire shape ruled by P1, 2026-11-05).
 *
 *   body (before zstd) = <the delta bytes, unchanged> + `{"vibecommit_commit_files":{"<40-hex sha>":["path", ...]}}\n`
 *   header             = `x-commit-files-length: <byte length of that trailer line, newline included>`
 *
 * ⛔ **ONLY A NUMBER RIDES IN A HEADER.** `CR-170` §4 measured commit messages over a header's 4096-byte limit for a quarter
 * of real commits, and a path list is no smaller. The paths travel in the body.
 *
 * ⛔ **THE LENGTH IS WHAT KEEPS THE TRAILER OUT OF THE TRANSCRIPT.** Ingest's bookkeeping is
 * `byte_offset = byteOffset + delta.length` plus a prefix hash; an extra line parsed out of the transcript would corrupt both.
 * With the length the server slices `delta = body[0 : len - n]` and `trailer = body[len - n :]` before anything else touches the
 * bytes. So the header and the trailer are ALL OR NOTHING: a header without its trailer would cut the end off the transcript, and
 * a trailer without its header would be stored as a transcript line.
 *
 * The list is git's own (`git diff-tree -z --name-only`, raw bytes decoded as UTF-8), UNCHANGED: this client does no matching and no
 * normalisation (D60 §D6). Plain `--name-only` C-quotes a non-ASCII or special path (`"\303\251.ts"`), which would never match an
 * Edit's `file_path`; `-z` does not.
 *
 * ⛔ **BOUNDS, enforced by the server too, and above them NO trailer is sent: nothing is truncated.** At most 1 MiB of trailer
 * and at most 10,000 paths per commit.
 */
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
export const COMMIT_FILES_HEADER = "x-commit-files-length";
/** The key of the one JSON object on the trailer line. */
export const COMMIT_FILES_KEY = "vibecommit_commit_files";
export const MAX_TRAILER_BYTES = 1024 * 1024;
export const MAX_PATHS_PER_COMMIT = 10_000;
/**
 * The trailer line for these commits, or `null` when none is to be sent: no commit has a path, any commit is over the path bound,
 * or the line is over the byte bound. Keys are exactly the shas given (a commit with no paths, a merge commit, is left out).
 */
export function buildCommitFilesTrailer(shas, files) {
    if (shas.length !== files.length)
        return null; // the pair is built together; a mismatch is a bug, and a wrong list is worse than none
    const doc = {};
    for (let i = 0; i < shas.length; i += 1) {
        const paths = files[i];
        if (paths.length > MAX_PATHS_PER_COMMIT)
            return null;
        if (paths.length > 0)
            doc[shas[i]] = paths;
    }
    if (Object.keys(doc).length === 0)
        return null;
    const line = Buffer.from(`${JSON.stringify({ [COMMIT_FILES_KEY]: doc })}\n`, "utf8");
    return line.length > MAX_TRAILER_BYTES ? null : line;
}
/**
 * `body` (a zstd frame of the delta) with the trailer appended BEFORE compression: decompress, append, compress again. Null when
 * the body is not a zstd frame we can open, in which case the caller sends neither the trailer nor the header.
 */
export function appendTrailer(body, trailer) {
    try {
        const delta = zstdDecompressSync(body);
        return zstdCompressSync(Buffer.concat([delta, trailer]));
    }
    catch {
        return null;
    }
}
/**
 * ⛔ THE ONE PLACE THE TRAILER IS DECIDED, and every condition is a way to send nothing. Returns the new body and the length for
 * `x-commit-files-length`, or `null`: then the body is sent as it is and NO header goes with it. The condition on `commits` is the
 * one `buildIngestHeaders` uses for `x-commits` (shas present, same length as attributions), so the trailer can never describe
 * commits the headers do not carry.
 */
export function planTrailer(gate, body) {
    const c = gate.commits;
    if (!gate.granted || !gate.isLast || gate.lean || gate.frameBytes === undefined || c === undefined)
        return null;
    if (c.shas.length === 0 || c.shas.length !== c.attributions.length)
        return null;
    const trailer = buildCommitFilesTrailer(c.shas, c.files);
    if (trailer === null)
        return null;
    const combined = appendTrailer(body, trailer);
    if (combined === null || combined.length > gate.frameBytes)
        return null;
    return { body: combined, length: trailer.length };
}
//# sourceMappingURL=commit_files.js.map