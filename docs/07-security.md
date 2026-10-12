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

## Implemented controls (Phase 04)

The review UI and API (`src/lib/review/`, `src/app/`, `src/components/`; D-012). Accounts are local reviewer accounts, not GitHub identities.
- **Control 8 (authentication):**
  - Usernames and scrypt passwords (N=2^15, r=8, p=1) are created by an operator with the owner database role; there is no sign-up. A stored hash is used only with N of 2^14 or 2^15, r = 8 and p of 1 or 2, so a stored row can't choose a cost that makes scrypt throw (tested).
  - A wrong password, an unknown username and a disabled account all get the same message, and an unknown well-formed username still pays for a scrypt check (`DUMMY_HASH` is tested to be a usable hash). A malformed username is refused at once, with no scrypt run and no database work: no account can have that name, so its timing reveals nothing (security M-A, tested). A rate-limited or busy attempt gets its own message, which says nothing about whether the username exists.
  - At most 5 attempts per username are checked in 15 minutes; further tries are refused, even with the right password. Each attempt is reserved as a failure under a per-username database lock before the password is checked, and deleted if it succeeds, so concurrent guesses can't exceed the limit (tested). The `/review` found the earlier count-then-record version checked all of 20 parallel attempts.
  - **Lockout (security L-D, accepted):** anyone who knows a username (usernames appear in the audit trail) can lock that reviewer out with 5 bad attempts every 15 minutes. `npm run reviewer:unlock -- --username <name>` clears the failures (owner role).
  - **Flood protection (security M-A):** at most 4 sign-ins are checked at once per process (`MAX_CONCURRENT_LOGINS`), and further concurrent attempts are refused as busy rather than queued (tested). Sign-in therefore can't take more than 4 of the 10 pooled database connections the webhook also uses, or more than 4 scrypt runs. Old failure rows are pruned through an index on `attempted_at`. **Required before exposing `/login` to untrusted networks:** an upstream per-IP rate limiter. Within a process the limits are per username and global, not per client.
  - **Logging (security L-E):** every sign-in logs `auth_login` with its outcome (`ok`, `invalid_credentials`, `rate_limited`, `busy`) and a request id, and every sign-out logs `auth_logout`. Usernames and passwords are never logged (tested).
  - Sessions are 32 random bytes in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` and the `__Host-` prefix in production), expire after 12 hours, and are stored only as a SHA-256 hash.
  - Every request checks the session against the database, so sign-out and disabling a reviewer take effect immediately.
  - All of this is tested: the database behaviour in `review.db.test.ts`, and the cookie options and sign-out in `actions.test.ts`. The production cookie name and `Secure` flag follow `NODE_ENV` and were not run in production mode.
- **Control 8 (authorization):** every read and every decision joins through `repository_reviewers` in SQL. A reviewer without a grant gets the same 404 as for a missing id, on pages and in the API, and ids are validated as UUIDs before any query (tested). Authorization is never left to the client or a proxy.
- **Control 9 (approval binding):**
  - The client sends only `decision` (and `editedPatch`). Extra keys such as `reviewerId` are rejected (tested).
  - The server takes the reviewer from the session and the proposal from the URL, reads the head SHA, base blob SHA and repository from the stored proposal, and stores the SHA-256 of the approved patch text. Stored proposals and candidates can't be updated or deleted by the app role (migration 0004, security L-A, tested), so the hash covers exactly what was shown. The earlier row lock was removed, because `SELECT … FOR UPDATE` needs UPDATE privilege; the unique `proposal_id` still makes one of many concurrent decisions win (tested).
  - Accepting re-runs `validatePatch` on the stored patch with its stored context, not just trusting `validation_status` (security L-B, tested). Rejecting approves nothing and is not re-validated.
  - One decision per proposal is enforced twice: by the check under the lock, and by `UNIQUE (proposal_id)`. With six concurrent decisions exactly one wins, and the constraint is tested on its own.
  - An edited patch goes through `validatePatch` with the proposal's stored context.
- **Audit trail:** the app role can only INSERT and SELECT `review_decisions`, and cannot create reviewers or grants (both tested with permission-denied errors). On `sessions` it can only INSERT and update `revoked_at`: it can't extend, un-revoke or delete a session (migration 0004, security L-C, tested). This makes the trail tamper-evident against edits, **not unforgeable**: the app role must insert sessions and decisions, so a compromised app could still insert a session or decision for any existing reviewer. A separate decision-writing role, or signed decisions, is a Phase 05 design choice. The review page shows the recorded decision, reviewer, time and binding.
- **Cross-site requests:** the session cookie is `SameSite=Strict`. `PATCH /api/reviews/:id` also requires a same-origin `Origin`, or `Sec-Fetch-Site: same-origin` when there is no `Origin`. Sign-in and sign-out are Server Actions, which Next.js refuses from another origin. All three were verified end to end against `next dev`.
- **Untrusted text in the UI:** documents, patches, evidence, PR titles and model text are rendered only as React text (no `dangerouslySetInnerHTML`, no Markdown rendering). Invisible and blank-rendering characters (bidi overrides, zero-width and other format characters, look-alike spaces, all default-ignorable code points such as Hangul fillers and variation selectors, and the braille blank) are replaced by labelled markers such as `U+202E`. The same characters are rejected in added patch lines and in patch target paths (security L-F, tested). Model text is labelled as model-written and unverified (tested). Reviewer display names are operator-set and rendered as plain text without markers.
- **Response headers (all routes):** `Content-Security-Policy` with `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`, plus `upgrade-insecure-requests` and `Strict-Transport-Security: max-age=31536000` in production (security L-G). Also `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and a restrictive `Permissions-Policy`. API responses are `no-store`.
  - **Verified against a production build (`next start`, 2026-10-12):** signed-in pages are `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate` (security Info 3); the API is `no-store`; HSTS is present; the cookie is `__Host-docusync_session` with `Secure`, `HttpOnly` and `SameSite=Strict`. `/login` is a static page with `s-maxage`, which is acceptable because it holds no user data.
- **Script CSP gap (D-012):** `script-src` allows `'unsafe-inline'`, because nonce CSP is incompatible with Cache Components' static shell. The defence against script injection is that untrusted text is never rendered as HTML.
- **No GitHub writes:** nothing in Phase 04 calls GitHub. Accepting a proposal is a database write only, and the UI says so.
- **Errors:** client errors are generic. The error page shows no details, and the API returns codes only. Any unexpected failure (database down, corrupt stored data) becomes `500 INTERNAL_ERROR` in the error envelope with a request id. The underlying error is neither returned nor logged, because database errors can name hosts and users (tested). Logs carry request ids and codes only.
- **Not yet:**
  - No multi-factor authentication.
  - No per-IP rate limit in the app: it must come from an upstream proxy before `/login` is exposed to untrusted networks (security M-A).
  - **Phase 05 requirements from the security check (Info 1-5):**
    - **Writes:** before any GitHub write, refuse fixture-sourced repositories; compare the binding against GitHub's current head and the blob at that head (the stored `base_blob_sha` is the hash of stored text); recompute and compare `patch_sha256`; re-check the reviewer's grant; and require a fresh approval. Decisions don't expire and are accepted on superseded heads today.
    - **Binding:** add the GitHub repository and installation id to it.
    - **Logging:** wrap page loaders and Server Actions so errors log only codes. Next's default error logging there is unverified.
    - **Operator tooling:** add disable, reset-password and revoke-grant commands and a narrower operator role than the owner; stop printing the generated password to stdout.
    - **Housekeeping:** prune expired sessions and cap sessions per reviewer.
  - No session rotation or "sign out everywhere".
  - Reviewers are not GitHub identities, so Phase 05 must authorize GitHub writes separately.
  - The approval binding is recorded but not yet compared against GitHub (Phase 05).
  - The base blob SHA is the hash of the stored text (security L4 from Phase 03).
  - A cross-site sign-in attempt gets Next.js's 500, not a 403.
  - **Status codes:** pages answer HTTP 200 for a missing or ungranted id (the not-found page is streamed) and for a signed-out visitor (a streamed redirect to `/login`), because those checks run inside `<Suspense>` after the shell is sent. No data is shown in either case (accepted, `/review` L4).
  - **Behind a proxy:** the decision API compares the browser's `Origin` with the URL the server sees. A proxy that terminates TLS or rewrites the host must forward them unchanged, or every decision gets 403. A configured expected origin is not built yet (`/review` L7).
  - **Sign-out:** the cookie is overwritten with its own options and `maxAge: 0`, because a bare `delete()` drops `Secure` and browsers then ignore it for `__Host-` cookies (fixed after `/review` L3, tested). The session is revoked on the server either way.

## Implemented controls (Phase 03)

Model calls and patch proposals (`src/lib/llm/`, `src/lib/patches/`, `src/lib/assist/`, D-011). Nothing calls them outside the CLIs and tests yet.
- **No model privileges:** the provider is a transport with one `chat` method. The model gets no tools, no credentials and no GitHub access; `llm/`, `patches/` and `assist/` import no GitHub or database code (tested).
- **Prompt injection (threat 2):**
  - Untrusted text (doc, diff hunks, evidence, PR title) is sent only as values inside one JSON-encoded user message, so it can't break out of its field (tested). Both system prompts state that the data is untrusted and its instructions must be ignored.
  - This is not relied on. The controls are structural: the model can't choose a target file (the output schema has no path, and unknown keys are rejected; tested), can't change deterministic candidates or evidence (tested), can cite only evidence it was given (bounded in the output schema; tested), and every patch must pass `validatePatch`.
  - The `injection-in-doc` fixture is tested with a mock model that obeys the injection (no_update, deleting the doc, a phishing URL, a script tag, bidi characters, editing text outside the doc): the deterministic result is unchanged and every malicious patch is rejected. An opt-in test runs the fixture against a real Ollama and checks the same invariants.
- **Control 6 (patch targets):** `docPathIssues` allows only `.md` and `.markdown` files at the repository root or under `docs/`, compared case-insensitively, and denies AI-agent instruction files (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `GEMINI.md`). It rejects anything failing `repoPathSchema`, non-NFC paths, `%`, `?` and `#`, segments starting with `.` (so `.git/` and `.github/`) or `-`, Windows reserved names and segments over 255 bytes (tested with a table of attacks). The security check narrowed the first version, which also allowed `.txt` (build inputs such as `requirements.txt`) and `.mdx` (code that runs at docs build time). The diff headers must name the target. Patches are applied to strings in memory, so symlink escapes can't occur here; the future doc fetcher must refuse symlink entries and use the same policy. **Not yet:** a per-repository allowlist.
- **Malicious or unrelated content (threat 9):** `validatePatch` rejects patches over 8,000 characters, 5 hunks or 40 changed lines, and removals over 30% of the doc. It also rejects hunks far from the evidence that name nothing from the PR (a weak heuristic: any PR name of 3+ characters counts), and unbalanced code fences.
  - **Added content:** control, bidi and zero-width characters, and carriage returns inside a line, are rejected. Any added raw HTML (tags, comments, declarations) that isn't already in the doc byte-for-byte is rejected, so attribute tricks (`alt=">"`, `/onerror`) don't matter.
  - **Links:** every link target, from Markdown links and images, reference definitions, autolinks, URL attributes and bare URLs or e-mail addresses, is decoded like a renderer does (backslash escapes, character references without a digit cap, whitespace) and resolved like a browser. `javascript:`, `vbscript:`, `data:` and `file:` are rejected. Any other external link must exactly match a link in the doc or the PR diff resolved the same way.
  - **Fix history:** `/review` fixed a first round of bypasses (`//host`, `www.`, host prefixes, reference-style `javascript:`, `<img/onerror>`, split tags). The security check then found a second round, all reproduced and now regression-tested: escaped or entity-encoded slashes, `http:host`, `\\host`, dotless hosts, other schemes and `mailto:`, image beacons, a quoted `>` before an event handler, zero-padded references, entity-encoded `data:`, and new HTML comments.
  - **Limits:** this narrows what a patch can carry; it is not a sanitizer, and renderers must still sanitize. Links planted anywhere in the PR's diff count as known. Look-alike letters are not detected. Validation can't tell whether prose is correct. The link extractor runs over the whole PR diff; the worst measured case was about 230 ms for 1 MB (the snapshot limit) of hostile text.
- **No fabrication:** no patch is requested unless the context has concrete change facts. In evaluation run 2 (docs/08), a model given no diff invented a port change, which is why this guard exists. Model failures fall back to deterministic-only results with an explicit `modelStatus`.
- **Stale revisions (control 10, partial):** each proposal records `headSha` and the doc's git blob SHA, and `validatePatch` fails with `PATCH_STALE_BASE` when the doc it is given doesn't match. In the current flow this can't fire: `assistImpact` hashes the doc and validates against the same doc, and nothing ties the docs to `headSha`. The hash is taken over the UTF-8 encoding of a JS string, not the raw bytes. Phase 04/05 must use the blob SHA GitHub returns at `headSha`, hash raw bytes (refusing invalid UTF-8 or a BOM), and re-check against GitHub before any write.
- **Control 7 (limits):** bounded context (6,000 characters of doc, 4,000 of diff, 2,500 of evidence excerpts, 200 of title); a prompt-size guard that refuses, instead of sending, a prompt that would not fit the model's context (`LLM_CONTEXT_TOO_LARGE`; a character estimate, not a tokenizer); a 256 KiB reply limit; a per-call timeout (default 120 s) that also covers reading the body (tested against a real local server that stalls mid-body); one retry for invalid output (with a different seed) and none for transport failures; the first transport failure stops all model calls for the PR; and at most 10 candidates per PR. The worst case is still long: 10 candidates × 4 calls × the timeout, about 80 minutes at the default. **Not yet:** a total time budget per PR and per-repository quotas (runner phase).
- **Control 13:** `OLLAMA_BASE_URL` must be `http` or `https` without credentials and defaults to loopback. Plain `http` is accepted only for loopback (`localhost`, `127.x`, `[::1]`) unless `OLLAMA_ALLOW_INSECURE_HTTP=true` is set explicitly. Redirects are refused, and the `eval:llm` version check is hardened the same way (no redirects, 4 KiB cap, version shape-checked before it goes into the report). Ollama itself has no authentication; keeping it on a private network remains a deployment rule (docs/10).
- **Logging:** model calls log the model, prompt version, duration and outcome only, never prompts, data or replies (tested).
- **Model text is untrusted output:** explanations and rationales that contain any link, e-mail address, HTML or hidden character are replaced with a fixed notice before they are stored (tested). Plain text can still be misleading, so the Phase 04 UI must label it as model-written and render it as plain text. The CLIs print everything through `toTerminalSafeJson`, which now escapes astral format characters (e.g. Unicode tag characters) as surrogate pairs that parse back to the same value (tested).
- **Not yet:** proposals are not persisted; approval binding and the GitHub-side staleness check are Phase 04/05; no Markdown link-target checking beyond the URL rule.

## Implemented controls (Phase 02)

The impact engine (`src/lib/impact-engine/`) is a pure function that nothing calls yet (D-010). When it is wired to real PRs, a PR author controls both the diff and, through the PR, the docs. These controls are in place and tested:
- **Untrusted text, regex safety (control 7):**
  - Every pattern applied to diff or doc text avoids super-linear backtracking.
  - Regression tests use hostile inputs: a 200,000-character Markdown-link line, a 30-segment dynamic route, and 64,000-space `package.json` lines.
  - Two exploitable patterns were found by the security check and fixed. The route matcher was exponential: 8.8 s at 16 segments, now 2 ms. The JSON key/value matcher was cubic: 70 s at 8,000 characters, now under 1 ms.
- **Work budgets (control 7):**
  - Signal names are capped at 200 characters, and context hints at 200 names per kind.
  - At most 300 signals are matched (removals and renames first), 10,000,000 doc characters indexed, and 20,000,000 doc lines scanned.
  - Each cap adds a `missingContext` note, so partial analysis is never silent.
  - **Not yet:** a wall-clock timeout or memory limit (runner phase: worker thread with `resourceLimits`).
- **No fabricated relationships (CLAUDE.md invariant):**
  - `likely_affected` requires a quoted line from the doc itself.
  - The README fallback is worded as a suggestion, not as a mention.
  - Evidence for removed lines in renamed files points at the old path.
  - Duplicate doc paths are rejected, so evidence line numbers are unambiguous.
- **Evidence integrity:** every evidence excerpt is tested against the exact fixture line it cites. Excerpts are quoted byte-exact, including any bidi or zero-width characters an attacker put in a doc.
- **Untrusted text in engine-written fields:** names and paths in `reason` and notes are reduced to a plain character set, so they can't break formatting or hide bidi or zero-width tricks. Quoted excerpts are not rewritten; the Phase 04 review UI must make invisible characters in them visible.
- **No probabilities:** `rankPoints` is documented and reported as rule points, never as a probability or confidence.
- **Not yet in place:**
  - `resolveDocLink` results are compared only against validated changed paths. They must never be used to choose a patch target without `repoPathSchema` plus the Phase 03 allowlist (`docPathIssues`, now in place).
  - The engine does not validate its snapshot or config inputs; callers must.

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
- No GitHub, Ollama or write code paths exist yet. (Superseded: Phase 01 added read-only GitHub code and Phase 03 an Ollama client. There are still no write paths.)

## GitHub workflow cautions

- Do not use privileged `pull_request_target` workflows to check out and execute untrusted PR code.
- Do not expose repository or app secrets to untrusted code.
- Do not automatically merge the generated documentation PR.
- Review third-party GitHub Actions and pin them to immutable commit SHAs for production.

## Incident response basics

Document how to revoke GitHub App credentials, rotate webhook secrets, disable write operations, inspect audit events and restore a known-good deployment.
