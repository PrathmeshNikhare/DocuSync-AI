import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { handleGetAnalysis } from "@/lib/review/api";
import { SESSION_COOKIE } from "@/lib/review/auth";
import { reviewerForToken } from "@/lib/review/session";

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/analyses/[id]">,
) {
  const { id } = await ctx.params;
  return handleGetAnalysis(request, id, {
    pool: getPool(),
    reviewerFor: () =>
      reviewerForToken(getPool(), request.cookies.get(SESSION_COOKIE)?.value),
  });
}
