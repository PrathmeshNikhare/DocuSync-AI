import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getPool } from "@/lib/db/pool";
import { SESSION_TTL_HOURS, reviewerForToken, type Reviewer } from "./session";

// `__Host-` requires Secure, which http://localhost can't set in development.
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production"
    ? "__Host-docusync_session"
    : "docusync_session";

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "strict",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_HOURS * 60 * 60,
} as const;

/**
 * The signed-in reviewer for this request, checked against the database every
 * time (so revocation is immediate). Deduplicated within one render, never cached
 * across requests.
 */
export const getCurrentReviewer = cache(
  async (): Promise<Reviewer | undefined> =>
    reviewerForToken(getPool(), (await cookies()).get(SESSION_COOKIE)?.value),
);

/** For pages: the reviewer, or a redirect to the login page. */
export async function requireReviewer(): Promise<Reviewer> {
  const reviewer = await getCurrentReviewer();
  if (!reviewer) redirect("/login");
  return reviewer;
}
