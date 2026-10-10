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

## Implemented controls (Phase 01)

These add to the Phase 00 list below.
- **Control 1:** the webhook HMAC-SHA256 is verified over the raw bytes with a constant-time compare, before JSON parsing or trusting any other header. The only header read earlier is `content-length`, used solely for the 1 MiB cap (413). The cap is enforced on the bytes actually streamed, so a missing or understated `content-length` does not bypass it, and the secret must be at least 20 characters. Tested, including tampered bodies and wrong secrets.
- **Control 2:** headers (event name, delivery UUID) and the `pull_request` payload are validated with Zod. Unknown events and actions are ignored with 202 rather than treated as errors. Tested.
- **Installation allowlist (security M1):** after the signature is verified, a delivery is queued only if its `installation.id` is listed in `GITHUB_ALLOWED_INSTALLATION_IDS`. Others get 202 `ignored` (`installation_not_allowed`) and nothing is written to the database. A missing or empty allowlist fails closed with 503. The App itself must be private ("Only on this account", docs/10). Tested. Per-repository quotas are still to be built (runner phase).
- **Control 3:** installation tokens are requested with `{ pull_requests: "read" }` only. The `GitHubReader` interface has no write methods. A request hook refuses any non-GET call before it reaches the network, with `GITHUB_WRITE_BLOCKED`. The only non-GET request is the token exchange, which runs on a separate client. Tested with a mocked `fetch`, including that GraphQL and pagination go through the same guarded request (by reading `@octokit/core`; no GraphQL test). **Not yet tested against real GitHub.** Installation tokens are short-lived (1 hour), but a reader caches its token for its lifetime with no refresh; that's fine for the one-shot CLI, but a long-running runner must refresh it. Tokens are not limited to one repository (`repositoryIds`); both are runner-phase work.
- **Control 5:** nothing checks out, installs or executes repository code. Ingestion reads PR metadata and file patches through the REST API only.
- **Control 6 (ingestion side):** every changed file path, and its previous path, must pass `repoPathSchema`. Failures are recorded as `{index, reason}` without echoing the raw path. Repository paths are passed to Octokit only as parameters, never concatenated into URLs (security L1).
- **Control 7:** limits are 1 MiB per webhook body, 300 files, 64,000 patch characters per file, 1,000,000 in total and 200 hunks per file. GitHub requests time out after 10 s. On the app's database pool, statements and sessions left idle inside a transaction time out after 10 s, and connections after 5 s. The migration client has no statement timeout, on purpose, because migrations can be long. PR numbers are capped at the Postgres `integer` maximum, so an oversized value gets 400, not 500. There are no automatic retries. **GitHub does not redeliver failed deliveries automatically**: a delivery that gets a 5xx or a timeout (for example while the database is down or the pool is exhausted) is lost unless someone redelivers it by hand within 3 days. A scheduled reconciliation job (list recent deliveries via the REST API and redeliver failures) is runner-phase work (security M2). Ingestion itself can be re-run with `npm run ingest`.
- **Control 11:** one analysis per repository, PR and head commit, enforced by a unique key and `INSERT … ON CONFLICT DO NOTHING` in one transaction. Tested with 8 concurrent duplicate deliveries. Replays don't rewrite rows: the repository row is updated only when owner, name or installation actually changed, and existing PR rows are never rewritten (tested by checking row versions). GitHub signatures carry no timestamp, so a captured delivery can be replayed. Replays are harmless here, but delivery ids are not stored (only the first one per analysis).
- **Control 12:** all SQL is parameterized. The app connects as `docusync_app`, which has SELECT, INSERT, UPDATE and DELETE on the application tables only. Migration `0002_restrict_app_role.sql` revokes all its access to `schema_migrations` and its TEMP privilege, and explicitly revokes CREATE on schema `public` from PUBLIC. Locally, `db/init/01-app-role.sql` also revokes CONNECT from PUBLIC on the `postgres`, `docusync` and `docusync_test` databases, so `docusync_app` can connect only to the two app databases. Tests confirm it cannot CREATE, DROP, ALTER or TRUNCATE, read or modify `schema_migrations`, or create temp tables. Migrations use the owner role. In production, the CONNECT revokes must be applied by whoever provisions the database.
- **Logging:** application logs go through `logEvent`, which copies only a fixed set of string fields (request id, delivery id, event, action, outcome, code, analysis id) at runtime, not just in the type. Octokit's built-in request logger and auth-app's logger are replaced with silent loggers, so GitHub errors are not printed with repository paths; they surface only as `GitHubReadError` codes. Tests confirm logs never contain the secret, signature, payload text or database URLs, and that a failing GitHub call prints nothing.
- **CLI output (L6):** `npm run ingest` prints the snapshot through `toTerminalSafeJson`, which escapes C1 controls, bidi/zero-width format characters and line/paragraph separators so untrusted titles and patches can't drive the terminal. The output still contains repository content (including private repositories); treat it as sensitive.
- **Control 10 (ingestion side):** `ingestPullRequest` reads the PR metadata again after listing files and fails with `GITHUB_STALE_HEAD` if the head or base moved. With `expectedHeadSha`, it fails before listing files if the head isn't the expected commit. This catches the common race (a push during ingestion) and is tested, but it is not a full guarantee. A head that moves and then moves back (A→B→A) between the two reads, or a push between pages of the file list, can go undetected. A commit-pinned diff (the compare API at the exact base and head SHAs) is planned once Contents read is available (Phase 02/05).
- **Error codes:** GitHub failures map to safe codes only. Primary and secondary rate limits map to `GITHUB_RATE_LIMITED`, transport failures with no HTTP response to `GITHUB_NETWORK_ERROR`, real 5xx responses to `GITHUB_UPSTREAM_ERROR`, and timeouts to `GITHUB_TIMEOUT`. The migrate CLI prints only its own messages, or a driver error code such as `MIGRATE_FAILED (28P01)`, never the driver's message (which can name the user and host).
- **Still open:** no authentication or authorization (control 8; Phase 04), no automatic ingestion of queued analyses (D-009), and no live GitHub verification.

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
- Local Postgres from Docker Compose binds to loopback (`127.0.0.1`) only. (Superseded in Phase 01: the app now connects as the least-privilege `docusync_app` user, with pool and statement timeouts; see above.)
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
