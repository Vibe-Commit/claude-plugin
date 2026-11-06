/** Read all of stdin as UTF-8; an error resolves to "" (an ordinary empty answer, never a throw). */
export function readStdin() {
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
//# sourceMappingURL=stdin.js.map