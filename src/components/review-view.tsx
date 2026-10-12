import Link from "next/link";
import type { ReviewView as Review } from "@/lib/review/queries";
import { CreatePrPanel, PullRequestLink } from "./create-pr-panel";
import { DecisionPanel } from "./decision-panel";
import { EvidenceList, ModelAssessment } from "./evidence";
import { SideBySideDiff } from "./side-by-side-diff";
import {
  ImpactBadge,
  Notice,
  Tag,
  formatTime,
  linkClass,
  shortSha,
} from "./ui";
import { VisibleText } from "./visible-text";

const DECISION_LABEL = {
  accepted: "Accepted",
  edited: "Accepted with edits",
  rejected: "Rejected",
} as const;

export function ReviewView({ review }: { review: Review }) {
  const { proposal, candidate, repository, pr, decision, output } = review;
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <p className="text-sm">
          <Link href={`/analyses/${review.analysisId}`} className={linkClass}>
            ← Back to the analysis
          </Link>
        </p>
        <h1 className="text-2xl font-semibold">
          Review:{" "}
          <span className="font-mono">
            <VisibleText text={proposal.targetPath} />
          </span>
        </h1>
        <section aria-label="What this decision applies to">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-neutral-600 dark:text-neutral-400">
              Repository
            </dt>
            <dd>
              <span className="font-mono">
                {repository.owner}/{repository.name}
              </span>{" "}
              {repository.source === "fixture" && (
                <Tag>Fixture data, not a live repository</Tag>
              )}
            </dd>
            <dt className="text-neutral-600 dark:text-neutral-400">
              Pull request
            </dt>
            <dd>
              #{pr.number} {pr.title && <VisibleText text={pr.title} />}
            </dd>
            <dt className="text-neutral-600 dark:text-neutral-400">
              Head commit
            </dt>
            <dd className="font-mono" title={proposal.headSha}>
              {shortSha(proposal.headSha)}
            </dd>
            <dt className="text-neutral-600 dark:text-neutral-400">
              Document revision
            </dt>
            <dd className="font-mono" title={proposal.baseBlobSha}>
              blob {shortSha(proposal.baseBlobSha)}
            </dd>
          </dl>
        </section>
      </header>

      <section aria-labelledby="why-heading" className="space-y-3">
        <h2 id="why-heading" className="text-lg font-semibold">
          Why this document
        </h2>
        <p className="text-sm">
          <ImpactBadge status={candidate.status} />{" "}
          <VisibleText text={candidate.reason} />
        </p>
        <EvidenceList evidence={proposal.evidence} />
        {candidate.missingContext.length > 0 && (
          <Notice tone="warning" title="Uncertainty">
            <ul className="list-disc pl-5">
              {candidate.missingContext.map((m, i) => (
                <li key={i}>
                  <VisibleText text={m} />
                </li>
              ))}
            </ul>
          </Notice>
        )}
        {candidate.modelAssessment && (
          <ModelAssessment
            assessment={candidate.modelAssessment}
            evidence={proposal.evidence}
          />
        )}
      </section>

      <section aria-labelledby="patch-heading" className="space-y-3">
        <h2 id="patch-heading" className="text-lg font-semibold">
          Proposed change
        </h2>
        <aside
          aria-label="Model rationale"
          className="rounded border-l-4 border-violet-400 bg-violet-50 px-3 py-2 text-sm dark:border-violet-600 dark:bg-violet-950"
        >
          <p className="font-medium">
            Rationale{" "}
            <span className="font-normal text-neutral-700 dark:text-neutral-300">
              (model-written
              {proposal.model ? ` by ${proposal.model.modelId}` : ""};
              unverified)
            </span>
          </p>
          <p className="mt-1">
            <VisibleText text={proposal.rationale} />
          </p>
        </aside>
        {proposal.validationStatus === "valid" && (
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            The patch passed validation: allowed documentation path, unchanged
            document revision, narrow and related to the evidence, and no new
            links, HTML or hidden characters. Validation limits what the patch
            can change; it does not check that the text is correct.
          </p>
        )}
        <SideBySideDiff
          path={proposal.targetPath}
          original={proposal.baseContent}
          patch={proposal.patch}
        />
        <details className="text-sm">
          <summary className="cursor-pointer">Raw patch</summary>
          <pre className="mt-2 overflow-x-auto rounded border border-neutral-200 p-3 font-mono text-xs dark:border-neutral-800">
            <VisibleText text={proposal.patch} />
          </pre>
        </details>
      </section>

      {decision ? (
        <section aria-labelledby="outcome-heading" className="space-y-3">
          <h2 id="outcome-heading" className="text-lg font-semibold">
            Decision
          </h2>
          <Notice
            tone={decision.decision === "rejected" ? "info" : "success"}
            title={DECISION_LABEL[decision.decision]}
          >
            <p>
              By {decision.reviewer.displayName} ({decision.reviewer.username})
              on {formatTime(decision.decidedAt)}.
            </p>
            <p className="mt-1">
              {decision.decision === "rejected"
                ? "This patch will not be used."
                : output?.step === "pr_opened" &&
                    output.prUrl &&
                    output.prNumber
                  ? "A documentation pull request was created for this decision."
                  : "No GitHub pull request has been created. Opening the documentation pull request is a separate, explicit step."}
            </p>
          </Notice>
          <h3 className="font-medium">Audit trail</h3>
          <table className="text-left text-sm">
            <caption className="sr-only">
              Recorded decision and what it is bound to
            </caption>
            <tbody>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Decision
                </th>
                <td>{decision.decision}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Reviewer
                </th>
                <td>{decision.reviewer.username}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Recorded
                </th>
                <td>{formatTime(decision.decidedAt)}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Head commit
                </th>
                <td className="font-mono">{decision.headSha}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Document blob
                </th>
                <td className="font-mono">{decision.baseBlobSha}</td>
              </tr>
              <tr>
                <th
                  scope="row"
                  className="pr-4 font-normal text-neutral-600 dark:text-neutral-400"
                >
                  Approved patch SHA-256
                </th>
                <td className="font-mono break-all">{decision.patchSha256}</td>
              </tr>
            </tbody>
          </table>
          {decision.editedPatch && (
            <>
              <h3 className="font-medium">Edited patch</h3>
              <SideBySideDiff
                path={proposal.targetPath}
                original={proposal.baseContent}
                patch={decision.editedPatch}
              />
            </>
          )}
          {decision.decision !== "rejected" &&
            (output?.step === "pr_opened" && output.prUrl && output.prNumber ? (
              <Notice tone="success" title="Documentation pull request">
                <PullRequestLink url={output.prUrl} number={output.prNumber} />.
                Review it on GitHub; it is never merged automatically.
              </Notice>
            ) : repository.source === "fixture" ? (
              <Notice tone="info" title="No pull request for fixture data">
                Fixture analyses are never written to GitHub.
              </Notice>
            ) : !review.writesEnabled ? (
              <Notice tone="info" title="GitHub writes are turned off">
                This server can&apos;t create pull requests. An operator must
                enable GitHub writes first.
              </Notice>
            ) : !pr.headRef ? (
              <Notice tone="warning" title="This analysis can't be published">
                It has no branch names recorded. Run a live analysis of the pull
                request again.
              </Notice>
            ) : (
              <CreatePrPanel
                proposalId={proposal.id}
                repository={repository}
                prNumber={pr.number}
                headRef={pr.headRef}
                headSha={decision.headSha}
                targetPath={proposal.targetPath}
                baseBlobSha={decision.baseBlobSha}
                baseContent={proposal.baseContent}
                approvedPatch={decision.editedPatch ?? proposal.patch}
                patchSha256={decision.patchSha256}
                lastError={output?.errorCode ?? null}
              />
            ))}
        </section>
      ) : proposal.validationStatus === "valid" ? (
        <DecisionPanel proposalId={proposal.id} patch={proposal.patch} />
      ) : (
        <Notice tone="warning" title="This proposal can't be decided">
          It did not pass validation ({proposal.validationIssues.join(", ")}).
        </Notice>
      )}
    </div>
  );
}
