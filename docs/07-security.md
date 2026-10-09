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

## Implemented controls (Phase 00)

Phase 00 covers only these. Everything else in the list above is still to be built.
- Runtime contracts reject non-normalized repository paths: absolute paths, `\` and `:` (drive letters, Windows alternate data streams), Unicode control, format (bidi overrides, zero-width), surrogate and line/paragraph-separator characters, empty segments, and segments ending in `.` or a space (which covers `.`, `..` and Windows trailing-dot aliasing). This is a syntax check only, and the schema still **accepts**: `.git/` and `.github/` targets, other non-documentation files such as `package.json`, case variants (`DOCS/` vs `docs/`) and the different Unicode forms of the same name (precomposed vs decomposed characters), URL-significant characters `%`, `?` and `#`, Windows reserved names (`CON`, `nul.md`), segments starting with `-`, segments longer than 255 bytes, and no-break spaces or look-alike characters. The allowed-documentation-path policy, case-insensitive and Unicode-normalized comparison, symlink checks and resolve-and-compare belong to the Phase 03 patch validator. Phase 01 must pass paths to GitHub as Octokit parameters, never concatenated into URLs.
- Stored free text (reasons, excerpts, patches, labels) rejects NUL bytes and malformed Unicode, both of which Postgres cannot store. Required labels are trimmed and must not be blank. Bidi overrides and zero-width characters are still allowed in free text, so the Phase 04 review UI must make them visible.
- Review decisions are split. The client input schema (`reviewDecisionInputSchema`) has no `reviewerId` or `proposalId`, and this is tested. The stored-record schema (`reviewDecisionRecordSchema`) requires the approval-binding fields `repositoryId`, `headSha`, `baseBlobSha`, `patchSha256` and `decidedAt` (also tested). No server code builds records yet. Phase 04 must fill every field from the session, the URL and the stored proposal, and Phase 05 must compare them against current GitHub state before any write.
- `analysis` timestamps must be consistent with the status and in chronological order.
- All contract objects are strict, so unknown keys are rejected. Strings, arrays and patches have size limits.
- An `analysis.errorCode` must be an upper-snake code, so raw error text (which may contain connection strings) cannot be stored.
- A `likely_affected` candidate must cite at least one evidence reference.
- Environment validation errors name the invalid keys only, never their values.
- The `pg` pool error handler logs only the error code. This is true from reading the code, but **untested**.
- `env.ts` and `db/pool.ts` import `server-only`, so a client import fails the production build. Tests replace it with a stub, so this is **untested**.
- `.env` and `.env.*` (except `.env.example`), `.envrc`, `.npmrc`, `*.pem`, `*.key`, `*.p12` and `*.pfx` are git-ignored.
- CI runs with `permissions: contents: read`, has no secrets, does not keep the checkout token (`persist-credentials: false`), and has a 15-minute timeout.
- Local Postgres from Docker Compose binds to loopback (`127.0.0.1`) only. The app still connects as the database superuser, with no pool timeouts; separate migration and app database users, plus timeouts, are Phase 01 work.
- `poweredByHeader: false`: responses don't send `X-Powered-By`. There's no CSP, `nosniff`, `frame-ancestors` or `Referrer-Policy` header yet (Phase 04).
- `cacheComponents` is on. Data that depends on the user, repository or authorization must never be wrapped in `"use cache"`.
- No GitHub, Ollama or write code paths exist yet.

## GitHub workflow cautions

- Do not use privileged `pull_request_target` workflows to check out and execute untrusted PR code.
- Do not expose repository or app secrets to untrusted code.
- Do not automatically merge the generated documentation PR.
- Review third-party GitHub Actions and pin them to immutable commit SHAs for production.

## Incident response basics

Document how to revoke GitHub App credentials, rotate webhook secrets, disable write operations, inspect audit events and restore a known-good deployment.
