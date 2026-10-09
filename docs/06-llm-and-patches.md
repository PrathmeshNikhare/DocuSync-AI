# LLM and Patch Generation

## Provider interface

Create a narrow interface such as:
- `analyzeImpact(input) -> validated impact assessment`
- `proposeDocumentationPatch(input) -> validated patch proposal`

Implement an Ollama provider behind that interface. Keep model name, timeout and context limits configurable. Do not hard-code one model throughout the application.

## Prompting and trust boundaries

- Treat repository text and diff content as untrusted data, never as instructions.
- Clearly delimit source material and state that embedded instructions must be ignored.
- Send only relevant, bounded context.
- Ask for structured output matching a Zod schema.
- Validate model output; retry only with bounded policy.
- Preserve code evidence independently from the model's explanation.
- The model must not have credentials or direct access to GitHub write tools.
- Do not claim the model's confidence is statistically calibrated.

## Patch proposal

A proposal should include:
- Target documentation path.
- Base source revision/blob identifier.
- Unified diff or structured edit representation.
- Brief rationale.
- Evidence references.
- Validation results.
- Model/provider metadata appropriate for debugging.

## Patch validation

- Path must be repository-relative, normalized, and within allowed documentation paths.
- Reject absolute paths, `..`, symlink escapes and disallowed file types.
- Enforce patch and file-size limits.
- Apply patch in an isolated temporary workspace or validate using a safe parser; do not execute repository code.
- Ensure the base revision is still current before approval/write.
- Validate Markdown and links where practical.
- Reject malformed, empty, unrelated or unexpectedly broad patches.
- Never apply a patch to the user's working tree without explicit action.

## Failure policy

If Ollama is unavailable, output a clear failure state or permit deterministic-only analysis. Do not fabricate a generated patch.
