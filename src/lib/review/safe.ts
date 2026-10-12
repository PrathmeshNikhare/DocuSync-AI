import "server-only";
import { randomUUID } from "node:crypto";
import { unstable_rethrow } from "next/navigation";
import { logEvent } from "@/lib/log";

/**
 * Runs a page loader or Server Action body. Next.js control flow (redirect,
 * notFound, prerender signals) passes through untouched. Any other error is
 * logged as a fixed code and replaced by a generic one, because database errors
 * can name hosts and users and Next would otherwise log them as they are.
 */
export async function codeOnlyErrors<T>(
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    unstable_rethrow(err);
    logEvent(name, {
      requestId: randomUUID(),
      outcome: "error",
      code: "INTERNAL_ERROR",
    });
    throw new Error("INTERNAL_ERROR");
  }
}
