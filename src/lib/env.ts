import "server-only";
import { z } from "zod";

// Only variables used by implemented code are validated. Later phases add theirs here.
const serverEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
});
export type ServerEnv = z.infer<typeof serverEnvSchema>;

/** Throws an error naming the invalid keys only; values (possibly secrets) are never included. */
export function parseServerEnv(
  source: Record<string, string | undefined>,
): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid server environment: ${keys.join(", ")}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Validated lazily on first use so `next build` does not need runtime secrets. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
