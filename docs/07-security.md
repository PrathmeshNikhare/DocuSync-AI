# Security and Threat Model

## Assets

GitHub credentials, repository source and documentation, user identity, review decisions, proposed patches, webhook secrets, database records.

## Threats

- Forged webhook events.
- Prompt injection embedded in source, diffs, docs or issue text.
- Malicious file paths or patch traversal.
- Unauthorized review/approval or insecure direct object references.
- Duplicate/replayed events and duplicate output PRs.
- Secret leakage through logs, prompts, errors or database.
- Untrusted code execution via scripts, package managers, tests or build hooks.
- Stale approval against a changed source revision.
- Model output that adds unrelated or malicious documentation content.
- Denial of service through huge diffs, files, prompts or repeated events.

## Required controls

1. Verify webhook signatures over the raw body.
2. Validate payload schemas and supported event/action types.
3. Use least-privilege GitHub App permissions and short-lived installation tokens where supported.
4. Keep secrets server-side; redact logs.
5. Never execute PR code or install dependencies from the analyzed repository.
6. Normalize and allowlist target paths; reject traversal and symlink escapes.
7. Apply body, file, diff, context, timeout and retry limits.
8. Authenticate users and authorize access per repository, analysis and review.
9. Bind approval to proposal ID, reviewer, target repo and source revision.
10. Re-check source SHA and permissions before creating a branch/PR.
11. Make webhook processing and PR creation idempotent.
12. Use parameterized SQL and least-privilege database credentials.
13. Keep Ollama/internal endpoints private; restrict outbound network access where practical.
14. Add security tests for each control before enabling write operations.

## GitHub workflow cautions

- Do not use privileged `pull_request_target` workflows to check out and execute untrusted PR code.
- Do not expose repository or app secrets to untrusted code.
- Do not automatically merge the generated documentation PR.
- Review third-party GitHub Actions and pin them to immutable commit SHAs for production.

## Incident response basics

Document how to revoke GitHub App credentials, rotate webhook secrets, disable write operations, inspect audit events and restore a known-good deployment.
