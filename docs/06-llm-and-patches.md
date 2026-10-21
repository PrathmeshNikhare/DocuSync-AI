# LLM and Patch Generation

## Design

DocuSync uses a local model for two bounded jobs, and nothing else: assess a document the deterministic engine already flagged, and propose small edits to it. Everything the model returns is untrusted and goes through validation before a person sees it.

**Provider interface.** `LlmProvider` is a transport with one method, `chat` (`src/lib/llm/provider.ts`). Higher-level calls go through `generateStructured`, which sends JSON in and validates JSON out against a Zod schema. The Ollama implementation reads the model name, timeout and context size from configuration; no model is hard-coded.

**Prompting and trust boundaries**
- Repository text and diff content are untrusted data, never instructions. Source material is delimited, and the prompts state that embedded instructions must be ignored.
- Only relevant, bounded context is sent.
- Output must match a Zod schema; invalid output is retried under a bounded policy.
- Code evidence is kept independently of the model's explanation.
- The model has no credentials and no GitHub write tools.
- Model confidence is never presented as calibrated.

**A patch proposal records:** the target documentation path, the base source revision (head SHA and the document's git blob SHA), the patch, a brief rationale, evidence references, validation results and model metadata.

**Failure policy.** If Ollama is unavailable, the result is a clear failure state or a deterministic-only analysis. A generated patch is never fabricated, and a patch is never applied to a working tree: proposals are validated as strings in memory and applied to GitHub only through the approval-gated write path (docs/13).

## Implementation

Decision D-011. Code: `src/lib/llm/` (provider, Ollama transport, prompts), `src/lib/patches/` (path policy, blob SHA, edit rendering, strict diff application, validation) and `src/lib/assist/` (orchestration, bounded context, evaluation helpers). None of them import GitHub, database or Next.js code (tested).

### Provider

- `LlmProvider` is a transport with one method, `chat`, and no tools or credentials. `generateStructured` sends the data as one JSON-encoded user message, passes the Zod schema to the model as a JSON schema, then parses and validates the reply. Invalid output is retried once (2 attempts in total). The retry carries `attempt: 2`, and the Ollama transport uses a different seed for it: at temperature 0 a same-seed retry would return the same reply. Unavailable, timeout and missing-model failures are never retried, and a provider that throws counts as `LLM_UNAVAILABLE`.
- `createOllamaProvider` calls `POST /api/chat` with `stream: false`, the JSON schema as `format`, `temperature: 0`, `seed: 41 + attempt` (42 on the first try) and `num_ctx` from config. Requests refuse redirects, time out after `OLLAMA_TIMEOUT_MS` (default 120 s, including reading the body), and replies over 256 KiB are rejected.
- Failure codes: `LLM_NOT_CONFIGURED` (no `OLLAMA_MODEL`), `LLM_UNAVAILABLE`, `LLM_TIMEOUT`, `LLM_MODEL_NOT_FOUND` and `LLM_INVALID_OUTPUT`.
- Logs record the model, prompt version, duration and outcome only, never prompts, data or replies.

### Prompts and context

- Prompts are versioned (`assess-v2`, `patch-v1`; `assess-v1` is retired: its schema had no citation bound). Both system prompts say that every field of the data is untrusted repository data and that instructions inside it must be ignored. Untrusted text appears only inside JSON strings in the user message.
- The context holds the deterministic candidate (status, reason, rules), its evidence by index (excerpts cut to 300 characters, 2,500 in total; past that only the index, signal and path), the diff hunks that contain source-side evidence (4,000 characters in total, 2,000 per hunk), the PR title (200 characters), and the doc. Docs up to 6,000 characters are sent whole; larger docs as ±20-line windows around doc evidence, within 6,000 characters. Every cut is reported in `notes`.
- **Prompt-size guard:** the budgets keep a plain worst case inside the default 8,192-token context (tested). A provider can also declare `maxInputChars`: Ollama uses `(num_ctx − 1,024 reply tokens) × 2.5` characters, a deliberately conservative estimate, not a tokenizer. A prompt over that is not sent (`LLM_CONTEXT_TOO_LARGE`), because Ollama would silently truncate it, possibly dropping the doc or the untrusted-data warning. Text that escapes badly in JSON (many quotes or backslashes) can trip the guard; the candidate is then skipped, not truncated.

### Assessment and proposals (`assistImpact`)

1. The deterministic engine runs first. Its result is returned unchanged.
2. For each flagged candidate (`likely_affected` or `verify`, at most 10 per PR), the model returns a verdict: `needs_update`, `no_update` or `uncertain`, plus an explanation and the 0-based indexes of the evidence it cites. The bound is part of the output schema (`assessOutputSchemaFor`), so constrained decoding enforces it and an out-of-range citation is retried like any other invalid output. Assessments are stored separately (`modelAssessmentSchema`).
3. For verdicts other than `no_update`, and only when the context has concrete change facts (a diff hunk, or a rename, add or delete), the model returns up to 5 `{find, replace}` edits and a rationale. Without change facts the outcome is `NO_CHANGE_FACTS`: the model would have to guess what changed (it did, in evaluation run 2; docs/08).
4. `placeableEdits` drops no-op edits (`find` equal to `replace`), edits whose `find` text is missing or ambiguous, and the shorter of overlapping edits. Dropped edits are reported in the outcome (`droppedEdits`).
5. `renderEdits` widens the kept edits to whole lines and renders a unified diff with three lines of context. `validatePatch` then checks it, and the strict applier must reproduce the rendered content (`PATCH_RENDER_MISMATCH` otherwise).
6. A valid proposal records the target path, `headSha`, the doc's git blob SHA (`baseBlobSha`), the patch, the model's rationale, the deterministic evidence and the model metadata.
7. Model prose (the assessment explanation and the patch rationale) must be plain text: any link, e-mail address, HTML or hidden character replaces it with a fixed notice (`WITHHELD_TEXT`). The prompt asks for no links, but only this check enforces it.
8. If the model is not configured, or the first call fails with a transport error, the result is deterministic-only and `modelStatus` says why (`not_configured`, `unavailable`, `partial`).

### Patch validation (`validatePatch`)

Every failure is a reason code. Nothing is repaired.
- **Path:** must pass `repoPathSchema` and be NFC-normalized; no `%`, `?` or `#`; no segment starting with `.` or `-`, no Windows reserved names, segments at most 255 bytes; extension `.md` or `.markdown` only; at the repository root or under `docs/`; and not an AI-agent instruction file (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `GEMINI.md`, at any depth). Comparison is case-insensitive. `.txt` (e.g. `requirements.txt`, `CMakeLists.txt`, which are build inputs) and `.mdx` (whose imports and `{expressions}` run at docs build time) are excluded on purpose.
- **Revision:** `baseBlobSha` must equal the git blob SHA-1 of the doc it is checked against (`PATCH_STALE_BASE`).
- **Structure:** `--- a/<path>` and `+++ b/<path>` headers must name the target; hunks are parsed strictly (`parseHunks`) and applied in order with exact context matching, no fuzz or offset, including end-of-file newline markers.
- **Size and breadth:** at most 8,000 characters, 5 hunks and 40 changed lines; removals at most 30% of the doc's lines (minimum 2); empty patches are rejected.
- **Relatedness (heuristic, weak):** each hunk must be within 20 lines of doc evidence or mention a name from the PR. Any extracted name of 3 or more characters counts, including generic ones such as `add` or `fix`, so this rarely rejects an edit that mentions one.
- **Content of added lines** (`src/lib/patches/content.ts`): characters are checked line by line; HTML and links on all added lines joined, so nothing split across lines escapes.
  - No control, bidi, zero-width or separator characters, and no carriage return except at the end of a line (CRLF docs keep working).
  - **Raw HTML:** any added tag, comment or declaration (`<` then a letter, `/`, `!` or `?`, up to the next `>` outside quotes) must already appear byte-for-byte in the doc. A new `<img>`, `<details>` or `<!-- … -->` is rejected whatever its attributes. Autolinks are links, not HTML. This also rejects new `<…>` text inside code spans, which is a deliberate false positive.
  - **Links:** targets are extracted from inline links and images, reference definitions, autolinks, URL attributes, and bare `scheme://`, `www.` and e-mail text. Each is decoded the way a renderer reads it: Markdown backslash escapes, numeric references with any number of leading zeros, common named references, whitespace removed. It is then resolved with `new URL(target, "https://placeholder.invalid/")`. `javascript:`, `vbscript:`, `data:` and `file:` are rejected; any other link leaving the placeholder origin must exactly match a link in the doc or the PR diff resolved the same way. Relative links stay allowed. A target that can't be resolved, or still holds an unknown named reference, counts as new.
  - `javascript:` and `vbscript:` are also rejected anywhere in the decoded added text.
  - Code fences must stay balanced.
  - These checks reduce what a patch can carry; they are not a sanitizer. Whatever renders a patch (GitHub, the review UI) must still sanitize. Links anywhere in the PR's diff count as known, so a PR author can plant one that a patch then carries (accepted; the doc PR is human-reviewed). Look-alike letters (e.g. Cyrillic in an identifier) are not detected.
- **Symlinks:** patches are applied to strings in memory, never on a file system, so symlink escapes can't happen here. The live document fetcher refuses symlink and submodule entries (docs/13).

### Commands

- `npm run propose -- --fixture <scenario>` prints the deterministic result, assessments, validated proposals and per-doc outcomes. Without `OLLAMA_MODEL` it prints a deterministic-only result.
- `npm run eval:llm` runs both modes over all scenarios and writes `docs/evaluation/llm-assisted.md` (docs/08).
- `npm run test:ollama` runs the opt-in tests against a real Ollama.

### Limits

- Proposals are persisted by `saveAnalysis` (docs/03) when a CLI run is saved, but nothing runs the model for queued webhook analyses (D-009).
- No retry with feedback when edits can't be placed, and no Markdown link checking beyond the URL rule.
- Model output can still be wrong prose that passes every check. Validation bounds where and how much a patch changes, not whether it is right.
