// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEdits } from "@/lib/patches/diff";
import type {
  AnalysisView as Analysis,
  Dashboard,
  ReviewView as Review,
} from "@/lib/review/queries";
import { AnalysisView } from "./analysis-view";
import { DashboardView } from "./dashboard-view";
import { ReviewView } from "./review-view";
import { SideBySideDiff } from "./side-by-side-diff";
import { VisibleText } from "./visible-text";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

const SHA = "a".repeat(40);
const repo = {
  id: "r1",
  source: "fixture" as const,
  owner: "fixture",
  name: "env-var-renamed",
};

describe("DashboardView", () => {
  it("explains how to get access when there are no repositories", () => {
    render(<DashboardView dashboard={{ repositories: [], analyses: [] }} />);
    expect(
      screen.getByRole("heading", { name: "No repositories yet" }),
    ).toBeTruthy();
    expect(screen.getByText(/reviewer:grant/)).toBeTruthy();
  });

  it("shows an empty state when a repository has no analyses", () => {
    render(
      <DashboardView
        dashboard={{ repositories: [{ ...repo, analyses: 0 }], analyses: [] }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "No analyses yet" }),
    ).toBeTruthy();
  });

  it("lists analyses with fixture labels, counts, failures and links", () => {
    const dashboard: Dashboard = {
      repositories: [{ ...repo, analyses: 2 }],
      analyses: [
        {
          id: "a1",
          repository: repo,
          prNumber: 1,
          headSha: SHA,
          status: "completed",
          errorCode: null,
          modelStatus: "not_configured",
          createdAt: "2026-10-11T10:00:00.000Z",
          candidates: 3,
          flagged: 2,
          proposals: 1,
          decided: 0,
        },
        {
          id: "a2",
          repository: repo,
          prNumber: 2,
          headSha: SHA,
          status: "failed",
          errorCode: "GITHUB_TIMEOUT",
          modelStatus: null,
          createdAt: "2026-10-11T09:00:00.000Z",
          candidates: 0,
          flagged: 0,
          proposals: 0,
          decided: 0,
        },
      ],
    };
    render(<DashboardView dashboard={dashboard} />);
    const table = screen.getByRole("table", { name: /recent analyses/i });
    const link = within(table).getByRole("link", {
      name: "fixture/env-var-renamed #1",
    });
    expect(link.getAttribute("href")).toBe("/analyses/a1");
    expect(within(table).getByText("2 of 3")).toBeTruthy();
    expect(within(table).getByText("(GITHUB_TIMEOUT)")).toBeTruthy();
    expect(within(table).getByText("model: not configured")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain(
      "1 recent analysis failed",
    );
    expect(screen.getAllByText(/fixture/i).length).toBeGreaterThan(1);
    expect(screen.getByText("2026-10-11 10:00 UTC")).toBeTruthy();
  });
});

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  id: "a1",
  repository: repo,
  pr: { number: 1, headSha: SHA, baseSha: SHA, title: "Rename API_TOKEN" },
  status: "completed",
  errorCode: null,
  createdAt: "2026-10-11T10:00:00.000Z",
  completedAt: "2026-10-11T10:00:01.000Z",
  engineVersion: "deterministic-0.3.0",
  modelStatus: "ok",
  missingContext: [],
  changedFiles: [
    {
      path: "src/config.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      patchState: "included",
    },
  ],
  candidates: [
    {
      id: "c1",
      docPath: "docs/configuration.md",
      status: "likely_affected",
      reason: `Mentions \`API_TOKEN\`${String.fromCodePoint(0x202e)}`,
      evidence: [
        {
          signal: "env_var",
          sourcePath: "src/config.ts",
          lineRange: { start: 3, end: 3 },
          side: "base",
          excerpt: "-  apiToken: process.env.API_TOKEN,",
        },
      ],
      missingContext: ["The patch for src/server.ts was not analysed."],
      rankPoints: 8,
      rules: ["env_var_removed"],
      modelAssessment: {
        docPath: "docs/configuration.md",
        verdict: "needs_update",
        explanation: "The doc lists the old name.",
        citedEvidence: [0],
        model: {
          provider: "ollama",
          modelId: "llama3.2:3b",
          promptVersion: "assess-v2",
        },
      },
      outcome: {
        docPath: "docs/configuration.md",
        assessment: "needs_update",
        patch: "valid",
      },
      proposal: { id: "p1", decision: null },
    },
  ],
  ...over,
});

describe("AnalysisView", () => {
  it("separates deterministic evidence, uncertainty and model output", () => {
    render(<AnalysisView analysis={analysis()} />);
    const card = screen.getByRole("article", { name: "docs/configuration.md" });
    expect(within(card).getByText("Likely affected")).toBeTruthy();
    expect(
      within(card).getByText("8 rule points").getAttribute("title"),
    ).toMatch(/not a probability/);
    expect(within(card).getByText("Evidence (deterministic)")).toBeTruthy();
    expect(within(card).getByText(/before the change/)).toBeTruthy();
    expect(within(card).getByText("Uncertainty")).toBeTruthy();
    const model = within(card).getByRole("complementary", {
      name: "Model assessment",
    });
    expect(model.textContent).toMatch(
      /model-written by llama3\.2:3b; unverified, not a confidence score/,
    );
    expect(
      within(card)
        .getByRole("link", { name: "Review proposed patch" })
        .getAttribute("href"),
    ).toBe("/reviews/p1");
  });

  it("makes a hidden bidi override in untrusted text visible", () => {
    render(<AnalysisView analysis={analysis()} />);
    expect(
      screen.getByLabelText("hidden character U+202E").getAttribute("title"),
    ).toBe("U+202E RIGHT-TO-LEFT OVERRIDE");
  });

  it("shows partial, failed, running and empty states", () => {
    const { unmount } = render(
      <AnalysisView analysis={analysis({ modelStatus: "not_configured" })} />,
    );
    expect(screen.getByText(/results are deterministic only/)).toBeTruthy();
    unmount();
    render(
      <AnalysisView
        analysis={analysis({
          status: "failed",
          errorCode: "INTERNAL_ERROR",
          candidates: [],
        })}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("INTERNAL_ERROR");
    expect(
      screen.getByRole("heading", { name: "No documentation candidates" }),
    ).toBeTruthy();
    cleanup();
    render(
      <AnalysisView
        analysis={analysis({
          status: "running",
          completedAt: null,
          candidates: [],
        })}
      />,
    );
    expect(screen.getByText("This analysis is running")).toBeTruthy();
    cleanup();
    render(
      <AnalysisView
        analysis={analysis({
          missingContext: ["Only the first 300 files were listed."],
        })}
      />,
    );
    expect(
      screen.getByText("Some of the pull request could not be analysed"),
    ).toBeTruthy();
  });

  it("explains why a document has no patch", () => {
    const base = analysis().candidates[0]!;
    render(
      <AnalysisView
        analysis={analysis({
          candidates: [
            {
              ...base,
              proposal: null,
              outcome: {
                ...base.outcome!,
                patch: "rejected",
                issues: ["PATCH_NEW_URL"],
              },
            },
          ],
        })}
      />,
    );
    expect(
      screen.getByText(/failed validation, so it is not shown/),
    ).toBeTruthy();
    expect(screen.getByText("(PATCH_NEW_URL)")).toBeTruthy();
  });
});

const DOC = "# Configuration\n\n| `API_TOKEN` | Token |\n";
const rendered = renderEdits("docs/configuration.md", DOC, [
  { find: "`API_TOKEN`", replace: "`API_KEY`" },
]);
const PATCH = rendered.ok ? rendered.patch : "";

const review = (over: Partial<Review> = {}): Review => ({
  proposal: {
    id: "p1",
    targetPath: "docs/configuration.md",
    headSha: SHA,
    baseBlobSha: "b".repeat(40),
    baseContent: DOC,
    patch: PATCH,
    rationale: "Renames the variable.",
    evidence: analysis().candidates[0]!.evidence,
    validationStatus: "valid",
    validationIssues: [],
    model: {
      provider: "ollama",
      modelId: "llama3.2:3b",
      promptVersion: "patch-v1",
    },
    createdAt: "2026-10-11T10:00:00.000Z",
  },
  candidate: {
    status: "likely_affected",
    reason: "Mentions `API_TOKEN`",
    rules: [],
    missingContext: [],
    modelAssessment: null,
  },
  analysisId: "a1",
  repository: repo,
  pr: { number: 1, headSha: SHA, baseSha: SHA, title: "Rename" },
  decision: null,
  ...over,
});

describe("ReviewView", () => {
  it("shows what the decision applies to, the diff and the decision controls", () => {
    render(<ReviewView review={review()} />);
    const target = screen.getByRole("region", {
      name: "What this decision applies to",
    });
    expect(
      within(target).getByText("Fixture data, not a live repository"),
    ).toBeTruthy();
    expect(within(target).getByText(SHA.slice(0, 12))).toBeTruthy();
    expect(within(target).getByText(`blob ${"b".repeat(12)}`)).toBeTruthy();
    expect(
      screen.getByRole("table", { name: /original document on the left/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("complementary", { name: "Model rationale" })
        .textContent,
    ).toMatch(/model-written by llama3\.2:3b; unverified/);
    expect(screen.getByRole("button", { name: "Accept…" })).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /back to the analysis/i })
        .getAttribute("href"),
    ).toBe("/analyses/a1");
  });

  it("shows the completion state and audit trail instead of controls once decided", () => {
    render(
      <ReviewView
        review={review({
          decision: {
            decision: "accepted",
            editedPatch: null,
            reviewer: { username: "alice", displayName: "Alice" },
            decidedAt: "2026-10-11T11:00:00.000Z",
            patchSha256: "c".repeat(64),
            headSha: SHA,
            baseBlobSha: "b".repeat(40),
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accept…" })).toBeNull();
    expect(screen.getByText("Accepted")).toBeTruthy();
    expect(
      screen.getByText(/No GitHub pull request has been created/),
    ).toBeTruthy();
    const trail = screen.getByRole("table", { name: /recorded decision/i });
    expect(within(trail).getByText("c".repeat(64))).toBeTruthy();
    expect(within(trail).getByText("alice")).toBeTruthy();
  });

  it("refuses decisions on a proposal that did not pass validation", () => {
    render(
      <ReviewView
        review={review({
          proposal: {
            ...review().proposal,
            validationStatus: "invalid",
            validationIssues: ["PATCH_STALE_BASE"],
          },
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Accept…" })).toBeNull();
    expect(
      screen.getByText(/did not pass validation \(PATCH_STALE_BASE\)/),
    ).toBeTruthy();
    // No contradictory "passed validation" claim for an invalid proposal.
    expect(screen.queryByText(/The patch passed validation/)).toBeNull();
  });
});

describe("SideBySideDiff and VisibleText", () => {
  it("labels removed and added lines for screen readers and collapses gaps", () => {
    const doc =
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const r = renderEdits("x.md", doc, [
      { find: "line 15\n", replace: "LINE 15\n" },
    ]);
    render(
      <SideBySideDiff path="x.md" original={doc} patch={r.ok ? r.patch : ""} />,
    );
    expect(screen.getByText("Removed:")).toBeTruthy();
    expect(screen.getByText("Added:")).toBeTruthy();
    expect(screen.getByText("11 unchanged lines")).toBeTruthy();
  });

  it("falls back to the raw patch text when it can't be laid out", () => {
    render(<SideBySideDiff path="x.md" original="a\n" patch="not a diff" />);
    expect(screen.getByText("not a diff")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders untrusted text as text, never as HTML", () => {
    const { container } = render(
      <VisibleText text={'<img src=x onerror="alert(1)">'} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe('<img src=x onerror="alert(1)">');
  });
});
