# Architecture

## Intended shape

- Next.js App Router: UI, authenticated dashboard routes and thin Route Handlers.
- Core modules under `src/lib/`: framework-independent business logic.
- GitHub adapter: verifies webhooks, fetches PR metadata/diffs, and later creates branches/PRs.
- Diff analyzer: parses diff metadata and extracts deterministic signals; never executes repository code.
- Impact engine: ranks documentation candidates and attaches evidence.
- LLM provider: interface with Ollama implementation and strict input/output schemas.
- Patch validator: validates allowed paths, patch boundaries and resulting Markdown.
- PostgreSQL: review sessions, candidates, proposals, decisions and idempotency records.
- Worker interface: long-running analysis can be moved out of request lifecycle; don't assume serverless handlers can run indefinitely.

## Data flow

1. Verify webhook signature using raw request body.
2. Record an idempotency key and enqueue/dispatch analysis.
3. Fetch bounded metadata and diffs with least-privilege credentials.
4. Parse changed files and deterministic evidence.
5. Select candidates; preserve reasons and evidence references.
6. Optionally ask the configured model for analysis and patch proposals.
7. Validate all model output against schemas and patch policy.
8. Persist proposals for human review.
9. On explicit approval, re-check authorization and source revision before GitHub writes.
10. Create a new documentation branch and pull request; never merge automatically.

## Module boundaries

Keep these concepts independently testable:
- `github/`: external API adapter.
- `diff-analyzer/`: parsing and deterministic signals.
- `impact-engine/`: candidate selection and ranking.
- `llm/`: provider interface, prompts and output validation.
- `patch-validator/`: safe patch rules.
- `review/`: decisions and state transitions.
- `db/`: migrations and repositories.
- `security/`: webhook validation, authz, redaction and path policy.

## Design principles

- Route Handlers are thin: parse, authenticate, validate, call services, map errors.
- Do not let UI components call GitHub or Ollama directly.
- Do not couple the impact engine to Next.js request/response types.
- Avoid adding infrastructure without a measured requirement.
