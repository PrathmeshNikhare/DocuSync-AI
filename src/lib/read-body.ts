/**
 * Reads at most `maxBytes` of the body. Returns null if the declared or actual
 * size is larger, without buffering the excess.
 */
export async function readBodyLimited(
  // Request or Response: anything with headers and a byte stream.
  request: Pick<Request, "headers" | "body">,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
