import { createHash } from "node:crypto";

/** Git's SHA-1 blob id for UTF-8 text: the same value `git hash-object` prints. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
}
