/**
 * Decodes a documentation blob from GitHub so that `gitBlobSha(text)` equals the
 * blob's id exactly: no BOM (TextDecoder would strip it silently), no NUL
 * (Postgres can't store it) and strictly valid UTF-8.
 */
export function decodeDocBytes(
  bytes: Uint8Array,
):
  | { ok: true; text: string }
  | { ok: false; issue: "DOC_BOM" | "DOC_NUL" | "DOC_NOT_UTF8" } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return { ok: false, issue: "DOC_BOM" };
  if (bytes.includes(0)) return { ok: false, issue: "DOC_NUL" };
  try {
    return {
      ok: true,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      ),
    };
  } catch {
    return { ok: false, issue: "DOC_NOT_UTF8" };
  }
}
