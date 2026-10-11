import { analyzeImpact, type ImpactResult } from "@/lib/impact-engine/engine";
import { extractSignals } from "@/lib/impact-engine/signals";
import {
  ASSESS_PROMPT_VERSION,
  ASSESS_SYSTEM,
  PATCH_PROMPT_VERSION,
  PATCH_SYSTEM,
  assessOutputSchemaFor,
  patchOutputSchema,
} from "@/lib/llm/prompts";
import {
  generateStructured,
  type LlmFailureCode,
  type LlmProvider,
} from "@/lib/llm/provider";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { proseIssues } from "@/lib/patches/content";
import { placeableEdits, renderEdits } from "@/lib/patches/diff";
import { validatePatch } from "@/lib/patches/validate";
import {
  modelAssessmentSchema,
  patchProposalSchema,
  type DocFile,
  type ModelAssessment,
  type PatchProposal,
  type PullRequestSnapshot,
} from "@/lib/schemas";
import { buildContext } from "./context";

/** Model calls for one PR are capped so a large PR cannot run up unbounded work. */
export const MAX_ASSISTED_CANDIDATES = 10;

/**
 * Version of the server-side policy around model calls, recorded in evaluations.
 * assist-v1: unplaceable edits are dropped (`placeableEdits`). assist-v2: no
 * patch without concrete change facts. assist-v3: evidence without a line number
 * brings its file's hunks into the context. assist-v4: a retry uses a new seed,
 * no-op edits are dropped, and stricter link and HTML checks apply. assist-v5:
 * links resolved like a browser, new raw HTML rejected, model prose withheld when
 * unsafe, smaller context budgets and a prompt-size guard.
 */
export const ASSIST_POLICY_VERSION = "assist-v5";

export interface CandidateOutcome {
  docPath: string;
  assessment: "needs_update" | "no_update" | "uncertain" | "failed" | "skipped";
  patch: "valid" | "rejected" | "no_change" | "failed" | "not_attempted";
  /** Model failure code, if a call failed. */
  code?: LlmFailureCode;
  /** Why a proposed patch was rejected. */
  issues?: string[];
  /** Why model edits were dropped before rendering (they could not be placed). */
  droppedEdits?: string[];
}

export interface AssistResult {
  /** The deterministic result, unchanged by anything the model says. */
  deterministic: ImpactResult;
  modelStatus: "ok" | "partial" | "unavailable" | "not_configured";
  assessments: ModelAssessment[];
  /** Validated proposals only. Rejected ones are listed in `outcomes`. */
  proposals: PatchProposal[];
  outcomes: CandidateOutcome[];
  /** Duration of each model call, for latency reporting. */
  callDurationsMs: number[];
}

/** Shown instead of model prose that fails `proseIssues`. */
export const WITHHELD_TEXT =
  "Model text withheld: it contained links, HTML or hidden characters.";

// Model prose reaches a reviewer next to the patch; it must not carry links or
// hidden text that could steer them. Patches themselves go through validatePatch.
const plainText = (text: string) =>
  proseIssues(text).length === 0 ? text : WITHHELD_TEXT;

// Failures that will repeat for every candidate: stop calling the model.
const FATAL: ReadonlySet<LlmFailureCode> = new Set([
  "LLM_NOT_CONFIGURED",
  "LLM_UNAVAILABLE",
  "LLM_TIMEOUT",
  "LLM_MODEL_NOT_FOUND",
]);

/**
 * Deterministic analysis first; then, for flagged candidates, a model assessment
 * and a patch proposal that must pass `validatePatch`. Without a usable model the
 * result is deterministic-only and says so. A patch is never invented.
 */
export async function assistImpact(
  snapshot: PullRequestSnapshot,
  docs: readonly DocFile[],
  provider: LlmProvider | undefined,
): Promise<AssistResult> {
  const deterministic = analyzeImpact(snapshot, docs);
  const flagged = deterministic.candidates.filter(
    (c) => c.status === "likely_affected" || c.status === "verify",
  );
  const result: AssistResult = {
    deterministic,
    modelStatus: provider ? "ok" : "not_configured",
    assessments: [],
    proposals: [],
    outcomes: [],
    callDurationsMs: [],
  };
  const skip = (docPath: string, code?: LlmFailureCode) =>
    result.outcomes.push({
      docPath,
      assessment: "skipped",
      patch: "not_attempted",
      ...(code ? { code } : {}),
    });

  const relatedTerms = [
    ...new Set(extractSignals(snapshot.files).signals.map((s) => s.value)),
  ];
  const diffText = snapshot.files
    .flatMap((f) => f.hunks.flatMap((h) => h.lines))
    .join("\n");
  let stopped: LlmFailureCode | undefined = provider
    ? undefined
    : "LLM_NOT_CONFIGURED";
  let anyOk = false;

  for (const [i, candidate] of flagged.entries()) {
    if (stopped || !provider || i >= MAX_ASSISTED_CANDIDATES) {
      skip(candidate.docPath, stopped);
      continue;
    }
    const doc = docs.find((d) => d.path === candidate.docPath)!;
    const data = buildContext(snapshot, doc, candidate);
    const fail = (code: LlmFailureCode, stage: "assess" | "patch") => {
      if (FATAL.has(code)) stopped = code;
      result.outcomes.push({
        docPath: candidate.docPath,
        assessment:
          stage === "assess" ? "failed" : result.assessments.at(-1)!.verdict,
        patch: stage === "assess" ? "not_attempted" : "failed",
        code,
      });
    };

    const assessed = await generateStructured(provider, {
      promptVersion: ASSESS_PROMPT_VERSION,
      system: ASSESS_SYSTEM,
      data: { task: "assess", ...data },
      schema: assessOutputSchemaFor(candidate.evidence.length),
    });
    result.callDurationsMs.push(assessed.durationMs);
    const assessment = assessed.ok
      ? modelAssessmentSchema.safeParse({
          docPath: candidate.docPath,
          verdict: assessed.value.verdict,
          explanation: plainText(assessed.value.explanation),
          citedEvidence: assessed.value.citedEvidence,
          model: assessed.meta,
        })
      : undefined;
    // The schema already limits citations to the evidence the model was given.
    if (!assessed.ok || !assessment?.success) {
      fail(assessed.ok ? "LLM_INVALID_OUTPUT" : assessed.code, "assess");
      continue;
    }
    anyOk = true;
    result.assessments.push(assessment.data);
    if (assessment.data.verdict === "no_update") {
      result.outcomes.push({
        docPath: candidate.docPath,
        assessment: "no_update",
        patch: "not_attempted",
      });
      continue;
    }

    // Without a diff hunk or a structural change there is nothing to base a patch
    // on; a model would have to guess what changed.
    const hasChangeFacts = data.changes.some(
      (c) =>
        c.hunks.length > 0 ||
        c.previousPath !== undefined ||
        c.status === "added" ||
        c.status === "removed",
    );
    if (!hasChangeFacts) {
      result.outcomes.push({
        docPath: candidate.docPath,
        assessment: assessment.data.verdict,
        patch: "not_attempted",
        issues: ["NO_CHANGE_FACTS"],
      });
      continue;
    }

    const proposed = await generateStructured(provider, {
      promptVersion: PATCH_PROMPT_VERSION,
      system: PATCH_SYSTEM,
      data: { task: "patch", ...data },
      schema: patchOutputSchema,
    });
    result.callDurationsMs.push(proposed.durationMs);
    if (!proposed.ok) {
      fail(proposed.code, "patch");
      continue;
    }
    const outcome: CandidateOutcome = {
      docPath: candidate.docPath,
      assessment: assessment.data.verdict,
      patch: "no_change",
    };
    result.outcomes.push(outcome);
    if (proposed.value.edits.length === 0) continue;

    const { kept, dropped } = placeableEdits(doc.content, proposed.value.edits);
    if (dropped.length > 0) outcome.droppedEdits = dropped;
    const rendered =
      kept.length > 0
        ? renderEdits(doc.path, doc.content, kept)
        : { ok: false as const, issues: [...new Set(dropped)] };
    const baseBlobSha = gitBlobSha(doc.content);
    const checked = rendered.ok
      ? validatePatch({
          targetPath: candidate.docPath,
          patch: rendered.patch,
          baseBlobSha,
          doc,
          relatedLines: candidate.evidence
            .filter((e) => e.sourcePath === doc.path && e.lineRange)
            .map((e) => e.lineRange!.start),
          relatedTerms,
          knownText: `${doc.content}\n${diffText}`,
        })
      : undefined;
    const issues = !rendered.ok
      ? rendered.issues
      : !checked!.ok
        ? checked!.issues
        : // Self-check: the strict applier must reproduce what the edits produced.
          checked!.content !== rendered.content
          ? ["PATCH_RENDER_MISMATCH"]
          : [];
    const proposal =
      issues.length === 0 && rendered.ok
        ? patchProposalSchema.safeParse({
            targetPath: candidate.docPath,
            headSha: snapshot.headSha,
            baseBlobSha,
            patch: rendered.patch,
            rationale: plainText(proposed.value.rationale),
            evidence: candidate.evidence,
            validationStatus: "valid",
            validationIssues: [],
            model: proposed.meta,
          })
        : undefined;
    if (proposal?.success) {
      outcome.patch = "valid";
      result.proposals.push(proposal.data);
    } else {
      outcome.patch = "rejected";
      outcome.issues = issues.length > 0 ? issues : ["PROPOSAL_SCHEMA_INVALID"];
    }
  }

  if (provider) {
    result.modelStatus =
      stopped && !anyOk
        ? "unavailable"
        : result.outcomes.some((o) => o.code || o.assessment === "skipped")
          ? "partial"
          : "ok";
  }
  return result;
}
