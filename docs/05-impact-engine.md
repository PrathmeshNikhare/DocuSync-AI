# Documentation Impact Engine

## Goal

Find likely affected documentation with explainable evidence and controlled uncertainty—not merely semantically similar text.

## Deterministic signals

- File path and file type changes.
- Explicit paths/URLs mentioned in source or docs.
- Imports/exports and symbol references where safely parseable.
- API route, environment variable, CLI command, package script and configuration changes.
- Existing documentation links to changed files or symbols.
- Repository conventions (README, docs/, ADRs, API reference).

Do not assume all source-to-doc relationships can be inferred exactly. Record the signal and its provenance.

## Candidate result schema (conceptual)

- `docPath`: normalized repository-relative path.
- `status`: `likely_affected`, `verify`, or `unlikely_affected`.
- `reason`: short human-readable explanation.
- `evidence[]`: source path, diff hunk/line reference where available, signal type, and excerpt bounded to the minimum necessary.
- `missingContext[]`: what could not be verified.
- `engineVersion`: version identifier for reproducibility.

## Selection workflow

1. Normalize paths and reject traversal/absolute paths.
2. Classify changed files.
3. Extract bounded deterministic signals.
4. Retrieve likely related docs through explicit references and repository conventions.
5. Rank candidates using transparent rules.
6. Optionally use the LLM to assess semantic impact.
7. Preserve evidence separately from generated reasoning.
8. Return `verify` when evidence is incomplete.
9. Measure precision and recall against labelled fixtures.

## Evaluation

- Precision = relevant flagged docs / all flagged docs.
- Recall = relevant flagged docs / all relevant docs in labelled set.
- Report counts and dataset definition alongside metrics.
- Measure by change category and repository size.
- Compare deterministic-only baseline with LLM-assisted mode.
- Do not claim general performance from a tiny synthetic dataset.
