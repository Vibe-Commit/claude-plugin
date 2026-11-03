/**
 * C67: linear tail trimming. `text.replace(/X+$/, "")` is quadratic on a long run of X followed by one other character (at every start inside the run the
 * quantifier runs to the end of the run and fails the anchor), so nothing that can see unbounded text uses it. One pass from the end instead.
 */
/** `text` without its trailing `char` (a single character) run. */
export function stripTrailing(text, char) {
    let end = text.length;
    while (end > 0 && text[end - 1] === char)
        end -= 1;
    return end === text.length ? text : text.slice(0, end);
}
/** `text` without its leading and trailing `char` runs. */
export function stripEnds(text, char) {
    let start = 0;
    while (start < text.length && text[start] === char)
        start += 1;
    return stripTrailing(text.slice(start), char);
}
//# sourceMappingURL=text_tail.js.map