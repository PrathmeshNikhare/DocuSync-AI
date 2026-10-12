import path from "node:path";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migrate } from "@/lib/db/migrate";
import { apiErrorSchema } from "@/lib/schemas";
import { appPool, requireTestDbUrls, withOwner } from "@/test/db";
import { addReviewer, grant, seedAnalysis } from "@/test/review-seed";
import {
  MAX_DECISION_BODY_BYTES,
  handleDecision,
  handleGetAnalysis,
  handleGetReview,
  type ApiDeps,
} from "./api";
import { hashPassword } from "./password";
import type { Reviewer } from "./session";

const { appUrl, ownerUrl } = requireTestDbUrls();
let pool: Pool;
let alice: Reviewer;
let seeded: Awaited<ReturnType<typeof seedAnalysis>>;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  await withOwner(ownerUrl, (c) =>
    migrate(c, path.join(process.cwd(), "migrations")),
  );
  pool = appPool(appUrl);
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await withOwner(ownerUrl, (c) =>
    c.query(
      "TRUNCATE repositories, reviewers, sessions, login_failures CASCADE",
    ),
  );
  const id = await addReviewer(
    ownerUrl,
    "alice",
    await hashPassword("x".repeat(12)),
  );
  alice = { id, username: "alice", displayName: "ALICE" };
  seeded = await seedAnalysis(pool);
  await grant(ownerUrl, id, seeded.repositoryId);
});

const ORIGIN = "http://localhost:3000";
// null means "no session" (undefined would pick the default reviewer).
const deps = (reviewer: Reviewer | null = alice): ApiDeps => ({
  pool,
  reviewerFor: async () => reviewer ?? undefined,
});
const patch = (body: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/reviews/${seeded.proposalId}`, {
    method: "PATCH",
    headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
    body,
  });

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  const body = (await res.json()) as unknown;
  const parsed = apiErrorSchema.safeParse(
    // `issues` sits beside the envelope for validation failures.
    typeof body === "object" && body
      ? { error: (body as { error: unknown }).error }
      : body,
  );
  expect(parsed.success).toBe(true);
  expect(parsed.data?.error.code).toBe(code);
  return body as { issues?: string[] };
}

describe("PATCH /api/reviews/:id", () => {
  it("records a decision for a same-origin, signed-in reviewer", async () => {
    const res = await handleDecision(
      patch('{"decision":"accepted"}'),
      seeded.proposalId,
      deps(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      decision: {
        decision: "accepted",
        proposalId: seeded.proposalId,
        reviewerId: alice.id,
      },
    });
  });

  it("refuses cross-site requests before anything else", async () => {
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted"}', { origin: "https://evil.example" }),
        seeded.proposalId,
        deps(),
      ),
      403,
      "FORBIDDEN_ORIGIN",
    );
    const noOrigin = new Request(`${ORIGIN}/api/reviews/x`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "cross-site",
      },
      body: "{}",
    });
    await expectError(
      await handleDecision(noOrigin, seeded.proposalId, deps()),
      403,
      "FORBIDDEN_ORIGIN",
    );
  });

  it("requires a session", async () => {
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted"}'),
        seeded.proposalId,
        deps(null),
      ),
      401,
      "UNAUTHENTICATED",
    );
  });

  it("rejects wrong content types, oversized and malformed bodies", async () => {
    await expectError(
      await handleDecision(
        patch("decision=accepted", {
          "content-type": "application/x-www-form-urlencoded",
        }),
        seeded.proposalId,
        deps(),
      ),
      415,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    await expectError(
      await handleDecision(
        patch("x".repeat(MAX_DECISION_BODY_BYTES + 1)),
        seeded.proposalId,
        deps(),
      ),
      413,
      "PAYLOAD_TOO_LARGE",
    );
    await expectError(
      await handleDecision(patch("{"), seeded.proposalId, deps()),
      400,
      "INVALID_JSON",
    );
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted","reviewerId":"someone"}'),
        seeded.proposalId,
        deps(),
      ),
      400,
      "VALIDATION_ERROR",
    );
  });

  it("maps decision outcomes to status codes", async () => {
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted"}'),
        "00000000-0000-4000-8000-000000000000",
        deps(),
      ),
      404,
      "NOT_FOUND",
    );
    const bad = await expectError(
      await handleDecision(
        patch(
          JSON.stringify({
            decision: "edited",
            editedPatch: "--- a/x\n+++ b/x\n",
          }),
        ),
        seeded.proposalId,
        deps(),
      ),
      422,
      "EDIT_INVALID",
    );
    expect(bad.issues?.length).toBeGreaterThan(0);
    expect(
      (
        await handleDecision(
          patch('{"decision":"rejected"}'),
          seeded.proposalId,
          deps(),
        )
      ).status,
    ).toBe(200);
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted"}'),
        seeded.proposalId,
        deps(),
      ),
      409,
      "INVALID_TRANSITION",
    );
  });

  it("answers PROPOSAL_NOT_VALID, not INVALID_TRANSITION, for an invalid proposal", async () => {
    await withOwner(ownerUrl, (c) =>
      c.query(
        `UPDATE patch_proposals SET validation_status = 'invalid', validation_issues = '["PATCH_STALE_BASE"]'`,
      ),
    );
    await expectError(
      await handleDecision(
        patch('{"decision":"rejected"}'),
        seeded.proposalId,
        deps(),
      ),
      409,
      "PROPOSAL_NOT_VALID",
    );
  });

  it("hides proposals from reviewers without a grant", async () => {
    const mallory = {
      id: await addReviewer(
        ownerUrl,
        "mallory",
        await hashPassword("y".repeat(12)),
      ),
      username: "mallory",
      displayName: "M",
    };
    await expectError(
      await handleDecision(
        patch('{"decision":"accepted"}'),
        seeded.proposalId,
        deps(mallory),
      ),
      404,
      "NOT_FOUND",
    );
  });
});

describe("GET /api/analyses/:id and /api/reviews/:id", () => {
  const get = (url: string) => new Request(`${ORIGIN}${url}`);

  it("return the analysis and review to a granted reviewer, uncached", async () => {
    const a = await handleGetAnalysis(
      get("/api/analyses/x"),
      seeded.analysisId,
      deps(),
    );
    expect(a.status).toBe(200);
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.json()).toMatchObject({
      id: seeded.analysisId,
      candidates: [{ docPath: "docs/configuration.md" }],
    });
    const r = await handleGetReview(
      get("/api/reviews/x"),
      seeded.proposalId,
      deps(),
    );
    expect(await r.json()).toMatchObject({
      proposal: { id: seeded.proposalId },
      decision: null,
    });
  });

  it("answer 401 without a session and 404 without a grant or for a bad id", async () => {
    await expectError(
      await handleGetAnalysis(get("/"), seeded.analysisId, deps(null)),
      401,
      "UNAUTHENTICATED",
    );
    const mallory = {
      id: await addReviewer(
        ownerUrl,
        "mallory",
        await hashPassword("y".repeat(12)),
      ),
      username: "mallory",
      displayName: "M",
    };
    await expectError(
      await handleGetAnalysis(get("/"), seeded.analysisId, deps(mallory)),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await handleGetReview(get("/"), seeded.proposalId, deps(mallory)),
      404,
      "NOT_FOUND",
    );
    await expectError(
      await handleGetReview(get("/"), "../../etc", deps()),
      404,
      "NOT_FOUND",
    );
  });
});
