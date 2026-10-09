# Phase 03 — Ollama Analysis and Patch Proposals

## Goal

Use a replaceable LLM provider to refine impact assessments and propose bounded documentation patches.

## Tasks

- Define provider interface and Ollama implementation.
- Add timeouts, bounded context, safe logging and clear unavailable-model behavior.
- Treat source content as untrusted data; test prompt injection fixtures.
- Validate structured model output with Zod.
- Preserve deterministic evidence separately from model explanations.
- Generate narrow patches only for allowed documentation paths.
- Validate patch structure, base revision, path, size and applicability.
- Add mocked provider tests and opt-in local Ollama integration tests.
- Never give the model GitHub credentials or write tools.

## Exit criteria

- Invalid model output is rejected.
- Timeout/unavailable Ollama produces a clear failure or deterministic-only result.
- Path traversal and unrelated/broad patches are rejected.
- Valid proposals include evidence and source revision.
- Model-assisted evaluation is compared with deterministic baseline.
- Docs/status/handoff updated.
