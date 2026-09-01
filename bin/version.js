/**
 * The client version that goes on the wire as `X-Client-Version` (CR-029).
 *
 * Deliberately a literal rather than an import of `package.json`: `rootDir` is
 * `./src`, so importing the manifest would drag it into `dist/` and change the
 * published tree shape. The cost of the literal is that it can drift from the
 * manifest — which is precisely what `scripts/check-version-skew.mjs` exists to
 * catch, and why CI runs it before publish.
 *
 * There is no version on the wire today and three separately-editable version
 * fields on disk (D58 plan §ER5/§ER14). This constant plus the skew check is the
 * whole fix: one source, asserted equal to the manifest and to the release tag.
 */
export const CLIENT_VERSION = "0.2.2";
/** Header name for the wire contract. */
export const CLIENT_VERSION_HEADER = "X-Client-Version";
//# sourceMappingURL=version.js.map