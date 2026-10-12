import type {
  EvidenceReference,
  ModelAssessment as Assessment,
} from "@/lib/schemas";
import { VisibleText } from "./visible-text";

// Typed against the enum, so a new signal kind can't silently lack a label.
const SIGNAL_LABEL: Record<EvidenceReference["signal"], string> = {
  path_change: "file path",
  import_export: "exported name",
  env_var: "environment variable",
  api_route: "API route",
  config_key: "config key",
  package_script: "npm script",
  cli_command: "CLI command",
  explicit_reference: "doc mention",
  doc_link: "doc link",
  repo_convention: "repository convention",
};

/** Deterministic evidence: what the engine matched, with exact quoted lines. */
export function EvidenceList({ evidence }: { evidence: EvidenceReference[] }) {
  if (evidence.length === 0) {
    return (
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        No line-level evidence was recorded.
      </p>
    );
  }
  return (
    <div className="text-sm">
      <p className="font-medium">Evidence (deterministic)</p>
      <ol className="mt-1 space-y-1">
        {evidence.map((e, i) => (
          <li
            key={i}
            className="rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900"
          >
            <span className="text-xs text-neutral-600 dark:text-neutral-400">
              [{i}] {SIGNAL_LABEL[e.signal]} ·{" "}
            </span>
            <span className="font-mono text-xs">
              <VisibleText text={e.sourcePath} />
              {e.lineRange &&
                `:${e.lineRange.start}${e.lineRange.end !== e.lineRange.start ? `-${e.lineRange.end}` : ""}`}
              {e.side === "base" && " (before the change)"}
            </span>
            {e.excerpt && (
              <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap">
                <VisibleText text={e.excerpt} />
              </pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Model output, kept visually apart from deterministic evidence and never trusted. */
export function ModelAssessment({
  assessment,
  evidence,
}: {
  assessment: Assessment;
  evidence: EvidenceReference[];
}) {
  return (
    <aside
      aria-label="Model assessment"
      className="rounded border-l-4 border-violet-400 bg-violet-50 px-3 py-2 text-sm dark:border-violet-600 dark:bg-violet-950"
    >
      <p className="font-medium">
        Model assessment: {assessment.verdict.replace("_", " ")}{" "}
        <span className="font-normal text-neutral-700 dark:text-neutral-300">
          (model-written by {assessment.model.modelId}; unverified, not a
          confidence score)
        </span>
      </p>
      <p className="mt-1">
        <VisibleText text={assessment.explanation} />
      </p>
      {assessment.citedEvidence.length > 0 && (
        <p className="mt-1 text-xs text-neutral-700 dark:text-neutral-300">
          Cites evidence{" "}
          {assessment.citedEvidence
            .filter((n) => n < evidence.length)
            .map((n) => `[${n}]`)
            .join(", ")}
        </p>
      )}
    </aside>
  );
}
