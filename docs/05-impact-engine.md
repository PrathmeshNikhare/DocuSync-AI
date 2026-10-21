# Documentation Impact Engine

## Goal

Find likely affected documentation with explainable evidence and controlled uncertainty, not merely semantically similar text. The engine is deterministic: the same snapshot and documents always give the same candidates. A model can later assess those candidates (see "Model-assisted mode"), but it never creates or changes them.

## Deterministic signals

- File path and file type changes.
- Explicit paths/URLs mentioned in source or docs.
- Imports/exports and symbol references where safely parseable.
- API route, environment variable, CLI command, package script and configuration changes.
- Existing documentation links to changed files or symbols.
- Repository conventions (README, docs/, ADRs, API reference).

Not every source-to-doc relationship can be inferred exactly, so each signal is recorded with its provenance and weak evidence is reported as uncertainty.

## Candidate result

- `docPath`: normalized repository-relative path.
- `status`: `likely_affected`, `verify`, or `unlikely_affected`.
- `reason`: short human-readable explanation.
- `evidence[]`: source path, diff hunk/line reference where available, signal type, and excerpt bounded to the minimum necessary.
- `missingContext[]`: what could not be verified.
- `engineVersion`: version identifier for reproducibility.

## Selection workflow

1. Normalize paths and reject traversal and absolute paths (ingestion).
2. Classify changed files.
3. Extract bounded deterministic signals.
4. Find related docs through explicit references and repository conventions.
5. Rank candidates with transparent rules.
6. Return `verify` when evidence is incomplete.
7. Optionally, outside the engine, ask the model to assess the flagged candidates. Evidence stays separate from generated reasoning.
8. Measure precision and recall against labelled fixtures (docs/08).

## Evaluation

- Precision = relevant flagged docs / all flagged docs. Recall = relevant flagged docs / all relevant docs in the labelled set.
- Counts and the dataset definition are always reported next to the metrics, and a tiny synthetic dataset is never used to claim general performance.
- Datasets, protocol, results and limits: docs/08 and `docs/evaluation/impact-baseline.md`, regenerated with `npm run eval:impact`.

## Implementation (engine `deterministic-0.3.0`)

Code: `src/lib/impact-engine/`. A pure function, `analyzeImpact(snapshot, docs, config?)`: no Next.js, database, GitHub or model imports (enforced by a test). It is called by the CLIs (`analyze`, `analysis:run`) and by `assistImpact`, not by any route handler or background job (D-009, D-010).

- **Input:** a `PullRequestSnapshot` (docs/02) and the documentation files at the PR head (`docFileSchema`: validated paths, storable text, at most 500 docs of 200,000 characters each, no duplicate paths). The docs come from `fixtures/` or, for live analyses, from git trees and blobs at the head commit (docs/13). Invalid doc input makes the engine throw a `ZodError`; callers map that to a safe error code.
- **Signals** (only changed lines create signals; context lines are hints, capped at 200 names per kind):
  - **Env vars** from `process.env.X`, `process.env["X"]`, `import.meta.env.X` and `.env*` lines.
  - **Exported names** from `export ...` declarations and `export { ... }` lists.
  - **API routes** from Next.js `app/**/route.ts` and `pages/api/**` paths, and from `get/post/...("/path")` calls.
  - **npm scripts** from `package.json`. Keys inside a visible `"scripts"` block are scripts, and keys in any other visible block are ignored. When the block header is out of view, a string value that isn't a version or package source, on a key that isn't a metadata field, is taken to be a script. Block state resets for every hunk.
  - **Config keys** only from application config files (under `config/`, files named `app`, `config`, `settings`, `default(s)`, `production`, `development`, `staging` or `local`, and `*.config.*`). CI workflows, tool configs, i18n and data JSON, and test fixtures give file-path signals only.
  - **File paths**, including the old path of a rename or deletion. A doc edited in place emits no path signal.
  - Names longer than 200 characters are dropped.
  - Each signal is `added`, `removed` or `modified` across the whole PR, and keeps its first changed line as evidence. Removed lines use `side: base`, and for a renamed file they point at the old path, where that line actually exists.
- **Doc matching:**
  - Each doc is split, tokenized and link-indexed once.
  - **Symbols that are a single token** (env vars, exported names, most scripts) are pre-checked against the doc's token set. Other values, paths and routes are pre-checked with a substring test. Only docs that pass the pre-check are scanned line by line.
  - Symbols use case-sensitive whole-word matching, where npm script names include `:` and `-`.
  - Routes don't extend into longer routes or sit inside an external URL. Dynamic segments match across `[id]`, `[...slug]`, `[[...slug]]`, `{id}` and `:id`, and the root route `/` is never matched.
  - Paths match as literal text, or via the doc's index of relative Markdown links.
- **Regex safety:** the patterns that see untrusted text are written to avoid super-linear backtracking, and each has a regression test with hostile input:
  - the Markdown-link pattern;
  - the route dynamic-segment pattern, whose alternatives are mutually exclusive (it was exponential before the security fix);
  - the `package.json` line patterns, which run on trimmed text with no ambiguous trailing quantifiers (they were polynomial before the security fix).
- **Rules** (`config.ts`):
  - Each match is worth a fixed number of points (env var 4, route 4, script 4, export 3, config key 3, path 3), doubled when the mentioned thing was removed or renamed away.
  - A new env var or script that no doc mentions adds 3 points to docs that list related ones, with a `missingContext` note. If no doc lists related ones, README.md gets a separate `undocumented_<kind>_readme_fallback` rule worded as "README.md is the default place to document it", with no claim that README mentions anything. Docs the PR itself edits count as mentioning the new name.
  - A total of 6 or more gives `likely_affected`, and 3 or more `verify`. `unlikely_affected` only occurs with a custom config, because the smallest default hit is 3 points.
- **Caps and exclusions:**
  - `likely_affected` requires at least one evidence line from the doc itself; otherwise the doc is capped at `verify` (rule `no_doc_evidence_cap`).
  - A doc whose decisive evidence comes from a file whose patch was not analyzed is capped at `verify` (rule `patch_unavailable_cap`), but only when the analyzed evidence alone would not reach `likely_affected`.
  - Docs the PR edits are listed in `docsChangedInPr` and not flagged. Symbols shorter than 3 characters are ignored.
  - **Budgets**, each of which adds a PR-level `missingContext` note when hit:
    - at most 300 signals, with renames, deletions and removed names matched first;
    - at most 10,000,000 doc characters (docs past it, in path order, are skipped);
    - at most 20,000,000 doc lines scanned in total (further matching stops).
  - Truncated file lists and rejected files are also reported as PR-level `missingContext`.
- **Output:** every candidate passes `impactCandidateSchema` and carries:
  - `rankPoints`: an integer sum of rule points. **Not a probability, not calibrated.**
  - The `rules` that fired.
  - A `reason` with the strongest matches first.
  - Up to 12 pieces of evidence, strongest hit first, each quoting an exact fixture line (tested).
  - **Bounds:** excerpts are at most 300 characters, and on long lines they are a window around the match. Notes and the reason are at most 500 characters, cut without splitting Unicode characters.
  - **Plain text in engine-written fields:** names and paths that the engine writes into `reason` and notes are reduced to plain characters (letters, digits, `_$:.-/@[]{}()+` and space; anything else becomes `?`). Quoted evidence excerpts are kept byte-exact.
- **Known blind spots:** behaviour changes that leave no name, path or key in the diff (false negatives); generic exported names that also appear in prose, such as `config` (false positives); dynamic env access; re-exports from other modules; languages other than TS/JS; semantic changes; `package.json` keys whose block header is out of view but which aren't scripts (guessed by the value heuristic). See `docs/evaluation/impact-baseline.md`.
- **Not built:** a wall-clock timeout and memory limit (a background runner could use a worker thread with resource limits). The budgets above bound the work but not the time per regex call.

## Model-assisted mode

- `assistImpact` (`src/lib/assist/`) asks the model to assess each flagged candidate: `needs_update`, `no_update` or `uncertain`. The assessment is stored next to the candidate and never changes it (D-011).
- In the evaluation, a flagged doc the model judges `no_update` counts as not flagged. The model never sees unflagged docs, so this mode can only remove false positives, not recover missed docs.
- Results for `llama3.2:3b` are in `docs/evaluation/llm-assisted.md` and docs/08. In every run so far the model judged every doc it assessed `needs_update` (in runs 1-5 one assessment per run was rejected over an off-by-one evidence citation; fixed in run 6), so model-assisted flagging equals the deterministic baseline.
