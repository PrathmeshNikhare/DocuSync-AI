import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import {
  handleDecision,
  handleGetReview,
  type ApiDeps,
} from "@/lib/review/api";
import { SESSION_COOKIE } from "@/lib/review/auth";
import { reviewerForToken } from "@/lib/review/session";

const deps = (request: NextRequest): ApiDeps => ({
  pool: getPool(),
  reviewerFor: () =>
    reviewerForToken(getPool(), request.cookies.get(SESSION_COOKIE)?.value),
});

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/api/reviews/[id]">,
) {
  return handleGetReview(request, (await ctx.params).id, deps(request));
}

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/reviews/[id]">,
) {
  return handleDecision(request, (await ctx.params).id, deps(request));
}
