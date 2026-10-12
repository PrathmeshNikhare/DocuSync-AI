import Link from "next/link";
import type {
  AnalysisView as Analysis,
  CandidateView,
} from "@/lib/review/queries";
import { EvidenceList, ModelAssessment } from "./evidence";
import {
  EmptyState,
  ImpactBadge,
  Notice,
  Tag,
  formatTime,
  linkClass,
  shortSha,
} from "./ui";
import { VisibleText } from "./visible-text";

const MODEL_STATUS: Record<string, { tone: "info" | "warning"; text: string }> =
  {
    not_configured: {
      tone: "info",
      text: "No model was configured for this analysis: results are deterministic only, and no patches were proposed.",
    },
    unavailable: {
      tone: "warning",
      text: "The model was unavailable: results are deterministic only, and no patches were proposed.",
    },
    partial: {
      tone: "warning",
      text: "The model answered for some documents only. Where it did not, the deterministic result stands.",
    },
  };

export function AnalysisView({ analysis }: { analysis: Analysis }) {
  const flagged = analysis.candidates.filter(
    (c) => c.status !== "unlikely_affected",
  );
  const model = analysis.modelStatus
    ? MODEL_STATUS[analysis.modelStatus]
    : undefined;
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          <span className="font-mono">
            {analysis.repository.owner}/{analysis.repository.name}
          </span>{" "}
          #{analysis.pr.number}{" "}
          {analysis.repository.source === "fixture" && <Tag>Fixture data</Tag>}
        </p>
        <h1 className="text-2xl font-semibold">
          {analysis.pr.title ? (
            <VisibleText text={analysis.pr.title} />
          ) : (
            `Pull request #${analysis.pr.number}`
          )}
        </h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-600 dark:text-neutral-400">
            Head commit
          </dt>
          <dd className="font-mono">{shortSha(analysis.pr.headSha)}</dd>
          <dt className="text-neutral-600 dark:text-neutral-400">Status</dt>
          <dd>
            {analysis.status}
            {analysis.errorCode && (
              <span className="ml-1 font-mono">({analysis.errorCode})</span>
            )}
          </dd>
          {analysis.completedAt && (
            <>
              <dt className="text-neutral-600 dark:text-neutral-400">
                Completed
              </dt>
              <dd>{formatTime(analysis.completedAt)}</dd>
            </>
          )}
          {analysis.engineVersion && (
            <>
              <dt className="text-neutral-600 dark:text-neutral-400">Engine</dt>
              <dd className="font-mono">{analysis.engineVersion}</dd>
            </>
          )}
        </dl>
      </header>

      {analysis.status === "failed" && (
        <Notice tone="error" title="This analysis failed">
          Error code <code>{analysis.errorCode}</code>. No documentation
          candidates were produced.
        </Notice>
      )}
      {(analysis.status === "queued" || analysis.status === "running") && (
        <Notice tone="info" title={`This analysis is ${analysis.status}`}>
          Results appear here when it completes.
        </Notice>
      )}
      {model && (
        <Notice tone={model.tone} title="Partial result">
          {model.text}
        </Notice>
      )}
      {analysis.missingContext.length > 0 && (
        <Notice
          tone="warning"
          title="Some of the pull request could not be analysed"
        >
          <ul className="list-disc pl-5">
            {analysis.missingContext.map((m, i) => (
              <li key={i}>
                <VisibleText text={m} />
              </li>
            ))}
          </ul>
        </Notice>
      )}

      <section aria-labelledby="files-heading">
        <h2 id="files-heading" className="text-lg font-semibold">
          Changed files ({analysis.changedFiles.length})
        </h2>
        <ul className="mt-2 space-y-1 text-sm">
          {analysis.changedFiles.map((f) => (
            <li key={f.path} className="font-mono">
              <VisibleText
                text={f.previousPath ? `${f.previousPath} → ${f.path}` : f.path}
              />{" "}
              <span className="text-neutral-600 dark:text-neutral-400">
                {f.status}, +{f.additions} −{f.deletions}
                {f.patchState !== "included" && `, diff ${f.patchState}`}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="candidates-heading" className="space-y-4">
        <h2 id="candidates-heading" className="text-lg font-semibold">
          Documentation that may need an update ({flagged.length})
        </h2>
        {analysis.candidates.length === 0 ? (
          <EmptyState title="No documentation candidates">
            <p>No document mentions anything this pull request changed.</p>
          </EmptyState>
        ) : (
          analysis.candidates.map((c) => <Candidate key={c.id} candidate={c} />)
        )}
      </section>
    </div>
  );
}

const PATCH_OUTCOME: Record<string, string> = {
  rejected:
    "A model patch was proposed but failed validation, so it is not shown.",
  no_change: "The model proposed no change.",
  failed: "The model failed while proposing a patch.",
};

function Candidate({ candidate: c }: { candidate: CandidateView }) {
  return (
    <article
      aria-labelledby={`cand-${c.id}`}
      className="space-y-3 rounded border border-neutral-200 p-4 dark:border-neutral-800"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`cand-${c.id}`} className="font-mono font-medium">
          <VisibleText text={c.docPath} />
        </h3>
        <ImpactBadge status={c.status} />
        <span
          className="text-xs text-neutral-600 dark:text-neutral-400"
          title="Sum of fixed rule points; not a probability"
        >
          {c.rankPoints} rule points
        </span>
      </div>
      <p className="text-sm">
        <span className="font-medium">Why: </span>
        <VisibleText text={c.reason} />
      </p>
      <EvidenceList evidence={c.evidence} />
      {c.missingContext.length > 0 && (
        <div className="text-sm">
          <p className="font-medium">Uncertainty</p>
          <ul className="list-disc pl-5">
            {c.missingContext.map((m, i) => (
              <li key={i}>
                <VisibleText text={m} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {c.modelAssessment && (
        <ModelAssessment assessment={c.modelAssessment} evidence={c.evidence} />
      )}
      <div className="text-sm">
        {c.proposal ? (
          <Link href={`/reviews/${c.proposal.id}`} className={linkClass}>
            {c.proposal.decision
              ? `View decision (${c.proposal.decision})`
              : "Review proposed patch"}
          </Link>
        ) : (
          <p className="text-neutral-700 dark:text-neutral-300">
            {(c.outcome && PATCH_OUTCOME[c.outcome.patch]) ??
              "No patch was proposed for this document."}
            {c.outcome?.issues && (
              <span className="ml-1 font-mono text-xs">
                ({c.outcome.issues.join(", ")})
              </span>
            )}
          </p>
        )}
      </div>
    </article>
  );
}
