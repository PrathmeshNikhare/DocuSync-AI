import type { NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import {
  getAllowedInstallationIds,
  getGitHubAppEnv,
  getGitHubAppSlug,
} from "@/lib/env";
import { openGitHubWriter } from "@/lib/github/writer";
import { handleCreatePr } from "@/lib/review/api";
import { SESSION_COOKIE } from "@/lib/review/auth";
import { reviewerForToken } from "@/lib/review/session";

export async function POST(
  request: NextRequest,
  ctx: RouteContext<"/api/reviews/[id]/create-pr">,
) {
  return handleCreatePr(request, (await ctx.params).id, {
    pool: getPool(),
    reviewerFor: () =>
      reviewerForToken(getPool(), request.cookies.get(SESSION_COOKIE)?.value),
    // Built only after the writes flag, session and body checks pass. Every
    // setting is validated here, so a misconfiguration costs no attempt.
    publish: () => {
      const app = getGitHubAppEnv();
      const slug = getGitHubAppSlug();
      const allowed = getAllowedInstallationIds();
      return {
        pool: getPool(),
        allowedInstallationIds: () => allowed,
        appSlug: () => slug,
        openWriter: (binding, signal) =>
          openGitHubWriter({
            appId: app.GITHUB_APP_ID,
            privateKey: app.GITHUB_APP_PRIVATE_KEY,
            binding,
            signal,
          }),
      };
    },
  });
}
