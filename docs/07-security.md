# Security and Threat Model

DocuSync AI reads pull requests, proposes documentation changes with the help of a local model, and, only after a recorded human approval, opens a documentation pull request. Everything it reads is attacker-controllable, so the design assumes hostile input at every boundary.

## Product invariants

These hold across the whole system. The controls below enforce them.

- **The model proposes; it does not approve or merge.** The model never chooses a file, writes a diff, holds credentials or calls GitHub. A human decision is required before any write, and nothing is merged automatically.
- **Source documentation is never silently overwritten.** A proposed patch is bounded to an allowed documentation path and validated before it is displayed or applied.
- **Untrusted data stays data.** Code, diffs, comments, documentation, filenames, issue text and model output are treated as untrusted. Code from an analysed pull request is never executed, built or installed.
- **External input is validated at runtime:** HTTP bodies, webhook payloads, environment variables, model output and persisted state (Zod schemas).
- **GitHub writes are unavailable by default** and require an explicit human approval recorded by the server.
- **Least privilege:** minimal GitHub App permissions, a least-privilege database role, secrets only on the server, and no secrets, tokens or private keys in logs.
- **No calibrated-probability claims:** model output is never presented as a confidence probability, and engine scores are rule points.
- **Deterministic evidence first:** diff ranges, imports, exports, routes, config keys, package scripts and file references back every flagged document. Where evidence is weak the system says so and asks for review; it does not invent a relationship.
- **Internal services are private:** Ollama and Postgres are never exposed to the internet.

## Assets

GitHub credentials, repository source and documentation, reviewer identity, review decisions, proposed patches, webhook secrets, database records.

## Threats

1. Forged webhook events.
2. Prompt injection embedded in source, diffs, docs or issue text.
3. Malicious file paths or patch traversal.
4. Unauthorized review or approval, and insecure direct object references.
5. Duplicate or replayed events and duplicate output PRs.
6. Secret leakage through logs, prompts, errors or the database.
7. Untrusted code execution via scripts, package managers, tests or build hooks.
8. Stale approval against a changed source revision.
9. Model output that adds unrelated or malicious documentation content.
10. Denial of service through huge diffs, files, prompts or repeated events.

## Controls

1. Verify webhook signatures over the raw body.
2. Validate payload schemas and supported event and action types.
3. Use least-privilege GitHub App permissions and short-lived installation tokens.
4. Keep secrets server-side; redact logs.
5. Never execute PR code or install dependencies from the analysed repository.
6. Normalize and allowlist target paths; reject traversal and symlink escapes.
7. Apply body, file, diff, context, timeout and retry limits.
8. Authenticate users and authorize access per repository, analysis and review.
9. Bind approval to proposal ID, reviewer, target repository and source revision.
10. Re-check the source SHA and permissions before creating a branch or PR.
11. Make webhook processing and PR creation idempotent.
12. Use parameterized SQL and least-privilege database credentials.
13. Keep Ollama and internal endpoints private; restrict outbound network access where practical.
14. Test each control before enabling write operations.

## Implemented controls

### Foundations

- **Strict contracts:** all Zod contract objects reject unknown keys, and strings, arrays and patches have size limits. An `analysis.errorCode` must be an upper-snake code, so raw error text (which may contain connection strings) cannot be stored. A `likely_affected` candidate must cite at least one evidence reference. Analysis timestamps must be consistent with the status and in chronological order.
- **Path syntax:** repository paths reject absolute paths, `\` and `:` (drive letters, Windows alternate data streams), Unicode control, format (bidi overrides, zero-width), surrogate and line or paragraph separator characters, empty segments, and segments ending in `.` or a space (which covers `.`, `..` and Windows trailing-dot aliasing). This is a syntax check; the allowed-documentation-path policy is in "Model calls and patch validation".
- **Stored free text** rejects NUL bytes and malformed Unicode, which Postgres cannot store. Required labels must not be blank. Bidi overrides and zero-width characters are allowed in stored text and made visible in the UI.
- **Review decisions are split:** the client input schema (`reviewDecisionInputSchema`) has no `reviewerId` or `proposalId`. The stored-record schema (`reviewDecisionRecordSchema`) requires the approval-binding fields `repositoryId`, `headSha`, `baseBlobSha`, `patchSha256` and `decidedAt`.
- **Environment validation** errors name the invalid keys only, never their values. `env.ts` and `db/pool.ts` import `server-only`, so a client import fails the production build. The `pg` pool error handler logs only the error code.
- **Git and Docker ignores:** `.env` and `.env.*` (except `.env.example`), `.envrc`, `.npmrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, password files, deployment env files and database dumps are git-ignored and docker-ignored.
- **CI** runs with `permissions: contents: read`, has no secrets, does not keep the checkout token (`persist-credentials: false`), pins its actions by commit SHA and has a 15-minute timeout.
- **`cacheComponents` is on.** Data that depends on the user, repository or authorization must never be wrapped in `"use cache"`.
- **`poweredByHeader: false`**, and the headers listed under "Review UI" on every route.

### Webhook intake and ingestion

- **Control 1:** the webhook HMAC-SHA256 is verified over the raw bytes with a constant-time compare, before JSON parsing or trusting any other header. The only header read earlier is `content-length`, used solely for the 1 MiB cap (413). The cap is enforced on the bytes actually streamed, so a missing or understated `content-length` does not bypass it. The secret must be at least 20 characters.
- **Control 2:** headers (event name, delivery UUID) and the `pull_request` payload are validated with Zod. Unknown events and actions are ignored with 202 rather than treated as errors. Drafts are ignored.
- **Installation allowlist (security M1):** after the signature is verified, a delivery is queued only if its `installation.id` is in `GITHUB_ALLOWED_INSTALLATION_IDS`. Others get 202 `ignored` and nothing is written. A missing or empty allowlist fails closed with 503. The GitHub App itself must be private ("Only on this account", docs/10).
- **Control 3 (read side):** installation tokens for reading are requested with `pull_requests: read` (plus `contents: read` for live analyses), and the live CLI scopes them to the one repository named on the command line. The `GitHubReader` interface has no write methods, and a request hook refuses any non-GET call before it reaches the network (`GITHUB_WRITE_BLOCKED`). The only non-GET request is the token exchange, which runs on a separate client. A reader caches its token for its lifetime with no refresh, which is fine for the one-shot CLI; a long-running runner would have to refresh it.
- **Control 5:** nothing checks out, installs or executes repository code. Ingestion reads PR metadata and file patches through the REST API only.
- **Control 6 (ingestion):** every changed file path, and its previous path, must pass `repoPathSchema`. Failures are recorded as `{index, reason}` without echoing the raw path. Repository paths are passed to Octokit only as parameters, never concatenated into URLs (security L1).
- **Control 7:** limits are 1 MiB per webhook body, 300 files, 64,000 patch characters per file, 1,000,000 in total and 200 hunks per file. GitHub requests time out after 10 s. On the app's database pool, statements and sessions idle inside a transaction time out after 10 s, and connections after 5 s. PR numbers are capped at the Postgres `integer` maximum. There are no automatic retries. **GitHub does not redeliver failed deliveries automatically**: a delivery that gets a 5xx or a timeout is lost unless someone redelivers it by hand within 3 days (docs/10). Ingestion itself can be re-run with `npm run ingest`.
- **Control 10 (ingestion):** `ingestPullRequest` reads the PR metadata again after listing files and fails with `GITHUB_STALE_HEAD` if the head or base moved. With `expectedHeadSha`, it fails before listing files if the head isn't the expected commit. This catches the common race but is not a full guarantee: a head that moves and moves back (A→B→A), or a push between pages of the file list, can go undetected, and the PR file list is not pinned to a commit.
- **Control 11:** one analysis per repository, PR and head commit, enforced by a unique key and `INSERT … ON CONFLICT DO NOTHING` in one transaction (tested with 8 concurrent duplicate deliveries). Replays don't rewrite rows. GitHub signatures carry no timestamp, so a captured delivery can be replayed; replays are harmless here.
- **Control 12:** all SQL is parameterized. The app connects as `docusync_app`, which has SELECT, INSERT, UPDATE and DELETE on application tables only, and further reductions on specific tables (below). Migration `0002_restrict_app_role.sql` revokes its access to `schema_migrations` and its TEMP privilege and revokes CREATE on schema `public` from PUBLIC. `db/init/01-app-role.sql` revokes CONNECT from PUBLIC on the local databases. Tests confirm the app role cannot CREATE, DROP, ALTER or TRUNCATE, read or modify `schema_migrations`, or create temp tables. In production, the CONNECT revokes must be applied by whoever provisions the database.
- **Logging:** application logs go through `logEvent`, which copies only a fixed set of string fields (request id, delivery id, event, action, outcome, code, analysis id) at runtime, not just in the type. Octokit's request logger and auth-app's logger are replaced with silent loggers, so GitHub errors are not printed with repository paths. Tests confirm logs never contain the secret, signature, payload text or database URLs.
- **CLI output:** `npm run ingest` prints through `toTerminalSafeJson`, which escapes C1 controls, bidi and zero-width format characters (including astral ones, as surrogate pairs that parse back to the same value) and line or paragraph separators, so untrusted text can't drive the terminal. The output still contains repository content; treat it as sensitive.
- **Error codes:** GitHub failures map to safe codes only: `GITHUB_RATE_LIMITED`, `GITHUB_NETWORK_ERROR`, `GITHUB_UPSTREAM_ERROR`, `GITHUB_TIMEOUT`. The migrate CLI prints only its own messages or a driver error code, never the driver's message (which can name the user and host).

### Impact engine

The engine (`src/lib/impact-engine/`) is a pure function. A PR author controls both the diff and, through the PR, the docs, so:
- **Regex safety (control 7):** every pattern applied to diff or doc text avoids super-linear backtracking, with regression tests on hostile inputs (a 200,000-character Markdown-link line, a 30-segment dynamic route, 64,000-space `package.json` lines). Two exploitable patterns were found by a security review and fixed: the route matcher was exponential (8.8 s at 16 segments, now 2 ms) and the JSON key/value matcher was cubic (70 s at 8,000 characters, now under 1 ms).
- **Work budgets (control 7):** signal names are capped at 200 characters and context hints at 200 names per kind. At most 300 signals are matched (removals and renames first), 10,000,000 doc characters indexed and 20,000,000 doc lines scanned. Each cap adds a `missingContext` note, so partial analysis is never silent. There is no wall-clock timeout or memory limit.
- **No fabricated relationships:** `likely_affected` requires a quoted line from the doc itself. The README fallback is worded as a suggestion, not as a mention. Evidence for removed lines in renamed files points at the old path. Duplicate doc paths are rejected, so evidence line numbers are unambiguous.
- **Evidence integrity:** every evidence excerpt is tested against the exact fixture line it cites. Excerpts are quoted byte-exact, including any bidi or zero-width characters an attacker put in a doc; the review UI makes them visible.
- **Untrusted text in engine-written fields:** names and paths in `reason` and notes are reduced to a plain character set.
- **No probabilities:** `rankPoints` is documented and reported as rule points, never as a probability or confidence.
- **Limits:** `resolveDocLink` results are compared only against validated changed paths and must never be used to choose a patch target without `repoPathSchema` and `docPathIssues`. The engine does not validate its snapshot or config inputs; callers must.

### Model calls and patch validation

Code: `src/lib/llm/`, `src/lib/patches/`, `src/lib/assist/` (D-011).
- **No model privileges:** the provider is a transport with one `chat` method. The model gets no tools, no credentials and no GitHub access; `llm/`, `patches/` and `assist/` import no GitHub or database code (tested).
- **Prompt injection (threat 2):**
  - Untrusted text (doc, diff hunks, evidence, PR title) is sent only as values inside one JSON-encoded user message, so it can't break out of its field. Both system prompts state that the data is untrusted and its instructions must be ignored.
  - This is not relied on. The controls are structural: the model can't choose a target file (the output schema has no path, and unknown keys are rejected), can't change deterministic candidates or evidence, can cite only evidence it was given (bounded in the output schema), and every patch must pass `validatePatch`.
  - The `injection-in-doc` fixture is tested with a mock model that obeys the injection (no_update, deleting the doc, a phishing URL, a script tag, bidi characters, editing text outside the doc): the deterministic result is unchanged and every malicious patch is rejected. An opt-in test runs the fixture against a real Ollama and checks the same invariants.
- **Control 6 (patch targets):** `docPathIssues` allows only `.md` and `.markdown` files at the repository root or under `docs/`, compared case-insensitively, and denies AI-agent instruction files (`AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `GEMINI.md`). It rejects anything failing `repoPathSchema`, non-NFC paths, `%`, `?` and `#`, segments starting with `.` (so `.git/` and `.github/`) or `-`, Windows reserved names and segments over 255 bytes (tested with a table of attacks). `.txt` (build inputs such as `requirements.txt`) and `.mdx` (code that runs at docs build time) are excluded. The diff headers must name the target. Patches are applied to strings in memory, so symlink escapes can't occur there; the doc fetcher refuses symlink and submodule entries. There is no per-repository allowlist.
- **Malicious or unrelated content (threat 9):** `validatePatch` rejects patches over 8,000 characters, 5 hunks or 40 changed lines, and removals over 30% of the doc. It rejects hunks far from the evidence that name nothing from the PR (a weak heuristic), and unbalanced code fences.
  - **Added content:** control, bidi and zero-width characters, and carriage returns inside a line, are rejected. Added raw HTML (tags, comments, declarations) that isn't already in the doc byte-for-byte is rejected, so attribute tricks (`alt=">"`, `/onerror`) don't matter.
  - **Links:** every link target (Markdown links and images, reference definitions, autolinks, URL attributes, bare URLs and e-mail addresses) is decoded like a renderer does and resolved like a browser. `javascript:`, `vbscript:`, `data:` and `file:` are rejected. Any other external link must exactly match a link in the doc or the PR diff resolved the same way. Two rounds of review found and closed bypasses (`//host`, `www.`, reference-style `javascript:`, escaped or entity-encoded slashes, `http:host`, `\\host`, dotless hosts, `mailto:`, image beacons, event handlers after a quoted `>`, zero-padded references, entity-encoded `data:`, new HTML comments); all are regression-tested.
  - **Limits:** this narrows what a patch can carry; it is not a sanitizer, and renderers must still sanitize. Links planted anywhere in the PR's diff count as known. Look-alike letters are not detected. Validation cannot tell whether prose is correct. The link extractor's worst measured case was about 230 ms for 1 MB (the snapshot limit) of hostile text.
- **No fabrication:** no patch is requested unless the context has concrete change facts. In an evaluation run (docs/08), a model given no diff invented a port change, which is why this guard exists. Model failures fall back to deterministic-only results with an explicit `modelStatus`.
- **Stale revisions (control 10):** each proposal records `headSha` and the doc's git blob SHA, and `validatePatch` fails with `PATCH_STALE_BASE` when the doc it is given doesn't match. For live analyses the doc is fetched through git trees and blobs at the head SHA, so the blob id is GitHub's own; the write path re-checks it against GitHub.
- **Control 7 (limits):** bounded context (6,000 characters of doc, 4,000 of diff, 2,500 of evidence excerpts, 200 of title); a prompt-size guard that refuses, instead of sending, a prompt that would not fit the model's context (`LLM_CONTEXT_TOO_LARGE`; a character estimate, not a tokenizer); a 256 KiB reply limit; a per-call timeout (default 120 s) that also covers reading the body; one retry for invalid output (with a different seed) and none for transport failures; the first transport failure stops all model calls for the PR; at most 10 candidates per PR. The worst case is still long (10 candidates × 4 calls × the timeout, about 80 minutes at the default). There is no total time budget per PR and no per-repository quota.
- **Control 13:** `OLLAMA_BASE_URL` must be `http` or `https` without credentials and defaults to loopback. Plain `http` is accepted only for loopback unless `OLLAMA_ALLOW_INSECURE_HTTP=true` is set. Redirects are refused, and the `eval:llm` version check is hardened the same way (no redirects, 4 KiB cap, version shape-checked). Ollama itself has no authentication; keeping it on a private network is a deployment rule (docs/10).
- **Model text is untrusted output:** explanations and rationales containing any link, e-mail address, HTML or hidden character are replaced with a fixed notice before they are stored. Plain text can still be misleading, so the UI labels it as model-written and unverified and renders it as plain text.
- **Logging:** model calls log the model, prompt version, duration and outcome only, never prompts, data or replies.

### Review UI, authentication and authorization

Code: `src/lib/review/`, `src/app/`, `src/components/` (D-012). Accounts are local reviewer accounts, not GitHub identities.
- **Control 8 (authentication):**
  - Usernames and scrypt passwords (N=2^15, r=8, p=1) are created by an operator with the owner database role; there is no sign-up. A stored hash is used only with N of 2^14 or 2^15, r = 8 and p of 1 or 2, so a stored row can't choose a cost that makes scrypt throw.
  - A wrong password, an unknown username and a disabled account get the same message, and an unknown well-formed username still pays for a scrypt check. A malformed username is refused at once with no scrypt run and no database work (security M-A).
  - At most 5 attempts per username are checked in 15 minutes, even with the right password. Each attempt is reserved as a failure under a per-username database lock before the password is checked and deleted if it succeeds, so concurrent guesses can't exceed the limit. At most 4 sign-ins are checked at once per process; extra concurrent attempts are refused as busy.
  - **Lockout (accepted, security L-D):** anyone who knows a username can lock that reviewer out with 5 bad attempts every 15 minutes. `npm run reviewer:unlock -- --username <name>` clears it (owner role).
  - **Required before exposing `/login` to untrusted networks:** a per-IP rate limiter upstream. The app limits per username and globally, not per client.
  - Every sign-in and sign-out logs an event with its outcome and a request id; usernames and passwords are never logged.
  - Sessions are 32 random bytes in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` and the `__Host-` prefix in production), expire after 12 hours, are capped at 10 per reviewer, and are stored only as a SHA-256 hash. Every request checks the session against the database, so sign-out and disabling a reviewer take effect immediately. Sign-out overwrites the cookie with its own options and `maxAge: 0`, because a bare `delete()` drops `Secure` and browsers then ignore it for `__Host-` cookies.
- **Control 8 (authorization):** every read and every decision joins through `repository_reviewers` in SQL. A reviewer without a grant gets the same 404 as for a missing id, on pages and in the API, and ids are validated as UUIDs before any query. Authorization is never left to the client or a proxy.
- **Control 9 (approval binding):**
  - The client sends only `decision` (and `editedPatch`); extra keys such as `reviewerId` are rejected.
  - The server takes the reviewer from the session and the proposal from the URL, reads the head SHA, base blob SHA and repository from the stored proposal, and stores the SHA-256 of the approved patch text. Stored proposals and candidates can't be updated or deleted by the app role (migration 0004), so the hash covers exactly what was shown.
  - Accepting re-runs `validatePatch` on the stored patch with its stored context (`PROPOSAL_NOT_VALID` otherwise). An edited patch goes through `validatePatch` with the same stored context.
  - One decision per proposal is enforced by the check and by `UNIQUE (proposal_id)`. With six concurrent decisions exactly one wins.
- **Audit trail:** the app role can only INSERT and SELECT `review_decisions` and cannot create reviewers or grants. On `sessions` it can only INSERT and update `revoked_at`. This makes the trail tamper-evident against edits, **not unforgeable**: the app role must insert sessions and decisions, so a compromised app could insert a session or decision for an existing reviewer (accepted, D-013).
- **Cross-site requests:** the session cookie is `SameSite=Strict`. `PATCH /api/reviews/:id` and the create-PR route also require a same-origin `Origin`, or `Sec-Fetch-Site: same-origin` when there is no `Origin`. Sign-in and sign-out are Server Actions, which Next.js refuses from another origin. Behind a TLS proxy the app compares the browser's `Origin` with `APP_ORIGIN` (a validated, normalized bare origin; an invalid value gives `503 CONFIG_INVALID`); without it every decision is refused with `FORBIDDEN_ORIGIN`.
- **Untrusted text in the UI:** documents, patches, evidence, PR titles and model text are rendered only as React text (no `dangerouslySetInnerHTML`, no Markdown rendering). Invisible and blank-rendering characters (bidi overrides, zero-width and other format characters, look-alike spaces, default-ignorable code points such as Hangul fillers and variation selectors, the braille blank) are replaced by labelled markers such as `U+202E`, and the same characters are rejected in added patch lines and patch target paths. Model text is labelled as model-written and unverified. Reviewer display names are operator-set and rendered as plain text.
- **Response headers (all routes):** `Content-Security-Policy` with `default-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`, `connect-src 'self'`, plus `upgrade-insecure-requests` and `Strict-Transport-Security: max-age=31536000` in production. Also `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin` and a restrictive `Permissions-Policy`. API responses are `no-store`; signed-in pages are `private, no-cache, no-store`. `/login` is a static page, which is acceptable because it holds no user data.
- **Script CSP gap (accepted, D-012):** `script-src` allows `'unsafe-inline'`, because nonce CSP is incompatible with Cache Components' static shell. The defence against script injection is that untrusted text is never rendered as HTML. This matters more because a write action exists.
- **Errors:** client errors are generic. The error page shows no details, and the API returns codes only. Any unexpected failure becomes `500 INTERNAL_ERROR` in the error envelope with a request id; the underlying error is neither returned nor logged, because database errors can name hosts and users. Page loaders and Server Actions log codes only.
- **Operator tooling:** reviewer accounts are managed with `reviewer:add`, `grant`, `revoke`, `disable`, `enable`, `unlock` and `sessions:prune`, all through the owner role. Generated passwords go to a new file, never stdout, and the account is committed only after the password file is written.
- **Not built:** multi-factor authentication, session rotation or "sign out everywhere", a reset-password command, a narrower operator role than the owner, and signed decisions. Decisions don't expire.
- **Status codes (accepted):** pages answer HTTP 200 for a missing or ungranted id and for a signed-out visitor (a streamed not-found or redirect), because those checks run inside `<Suspense>` after the shell is sent. No data is shown in either case. A cross-site sign-in attempt gets Next.js's 500, not a 403.

### GitHub write path

Design: docs/13 (D-013). Verified against a fetch-level fake of GitHub and the test database, and once against a live GitHub App without the recommended ruleset (docs/10).
- **Writes off by default:** `GITHUB_WRITES_ENABLED` must be exactly `true`. It is checked first in `POST /api/reviews/:id/create-pr` (503 `WRITES_DISABLED` before the session is looked at), again in the publish flow, and inside the writer before it mints a token and before every mutating request. A missing `GITHUB_APP_SLUG` fails with `503 WRITES_MISCONFIGURED` before any attempt or token.
- **Control 3 (least privilege):**
  - The writer mints a new installation token per operation, asking for `contents: write` and `pull_requests: write` for exactly one repository id. The token response must show exactly that scope (GitHub's implicit `metadata: read` allowed), or the operation stops with `GITHUB_TOKEN_SCOPE`. The token is revoked in a `finally` on every path, with its own timeout so it still runs after the operation's 45 s deadline.
  - **Two-layer request guard** (`src/lib/github/writer.ts`), both tested on their own: the Octokit hook allows only exact (method, route template) pairs with exact parameters and body keys; a wrapping `fetch` re-checks host, method, decoded path, query and body on the real request.
  - Refused before anything is sent: merges and deletes, GraphQL, literal URLs, other repositories, paths, branches, trees or blobs; a `PUT` without `branch`, a near-miss branch name, a `committer` key, a branch at another commit; a PR into another base, with `maintainer_can_modify: true`, or converting an issue; `baseUrl`, header and `fetch` overrides.
  - Redirects are never followed (`GITHUB_REDIRECT`). The token client may call only the token endpoint for the binding's installation, repository and permissions. The writer has no merge, delete or generic request method (tested on its method list).
- **Controls 9 and 10 (binding and re-checks):** every attempt re-checks, in order:
  - session, grant (ungranted ids are 404) and decision state;
  - the deciding reviewer still enabled and granted (`DECISION_REVOKED`);
  - the echoed `headSha` and `patchSha256`, then the decision against its proposal chain;
  - the patch hash, then `validatePatch`;
  - fixture source, installation allowlist and recorded branch names, then the attempt limits.
  Then on GitHub: the PR is open, in the same repository by id, not from a fork or a deleted fork; its head SHA and both branch names are unchanged; the target's tree entry, walked one directory at a time, is a regular file with the reviewed blob id. The blob's bytes must hash to that id and equal the stored base text exactly. The file written is the approved patch applied to that text, through a `PUT` conditioned on the base blob SHA. Each check has a refusal test with zero GitHub requests or no document write.
- **Control 11 (idempotency):** `github_outputs` has one row per decision. A random-token lease (60 s) guards each attempt, and the operation has a 45 s deadline. Progress writes need the live lease (`LEASE_LOST` otherwise). Steps are persisted and resumed; a repeated request returns the stored URL without calling GitHub. A lost commit is adopted only if `compare` shows exactly one commit on the reviewed head that changes only the target to the expected blob. Only the App bot's own PR is adopted; an extra commit or a foreign PR on the branch gives `BRANCH_CONFLICT`. At most 5 attempts, 30 s apart.
- **Only our commit in the PR (security M-1):** DocuSync's commit must have exactly the reviewed head as its parent; before creating the PR, the branch tip must be that commit and `compare` must show exactly our change; the created PR's head must be that commit (`PR_HEAD_MISMATCH` otherwise, never recorded); the PR body names the commit. **Residual:** commits pushed after the PR opens are stopped only by a `docusync/**` ruleset, which docs/10 requires before enabling writes and which the code cannot verify.
- **Trust in the app database role (accepted, D-013):** whoever holds `DATABASE_URL` can insert sessions, proposals and decisions, and so can make the App open a bounded docs PR in an allowlisted installation's repository. Migration 0005 limits the damage: repository identity (`github_repo_id`, `source`) can't be updated by the app role, output bindings are fixed after insert, and the attempt log is append-only (tested with permission-denied errors). A stolen App private key is limited only by GitHub-side controls (docs/10: rulesets, optionally a separate write App).
- **PR content:** every value from the PR, the model or an operator is rendered only inside code spans or fenced blocks sized past its longest backtick run. Links are server-built github.com autolinks. The rationale must also pass `proseIssues`. Titles and commit messages neutralize `@` and `#`. Reviewers appear by display name, never username. The body is capped at 60,000 characters in whole blocks. Hidden and bidi characters in PR text become `[U+XXXX]`.
- **Live analysis guard:** the live CLI requires the read token's single repository to be the PR's repository, refuses forks, and stores GitHub's canonical owner and name. Writes refuse fixture data.
- **Rate limits and logging:** per-reviewer limits of 60 decisions and 10 create-PR requests per minute, an early exit for blocked outputs, and logs of request id, reviewer id, output id, outcome and code only. Tokens, keys, patch text, file content and GitHub messages are never logged or returned.
- **Not built:** a live run under a ruleset, signed decisions, decision expiry, and pinning the PR file list to a commit.

### Database, deployment and operations

- **Least-privilege roles:** `docusync_app` (the app), a schema owner for migrations and operator commands, and a bootstrap superuser used only by init scripts. In the reference deployment the owner is a non-superuser (`docusync_owner`, D-015); dev and CI use a superuser owner and so test less strictly. The web app must receive only the app-role URL.
- **`npm run db:check-grants`** exits non-zero if any app-role limit is missing: whole-table privileges, every column of the column-restricted tables (read from the database), single-column grants (`has_any_column_privilege`), TRUNCATE on every table, database TEMPORARY, schema CREATE, and role attributes (superuser, `CREATEDB`, `CREATEROLE`, replication, `BYPASSRLS`, role membership). Run it after every restore: `pg_restore` into a database with default privileges silently gives the app role `UPDATE` and `DELETE` back on restricted tables, and a dump without `--create` drops the database-level revokes (docs/10 has the verified procedure). The migrate job runs it after migrations.
- **Public surface (security M-A):** the reference proxy's public site serves only `/api/webhooks/github`; `/login` and the rest of the API give 404 publicly. The reviewer UI is a separate site on a port that must stay private.
- **Deployment init (security L-3, L-5):** the app and owner roles are created without login and granted login only with a real password. The init refuses placeholder, short or reused passwords, so a failed first start fails closed. The password never appears as a `psql` argument.
- **No secrets in images (security L-1):** the Dockerfile copies an explicit file list, and `.dockerignore` excludes secret patterns at any depth. Planted dummy keys, password files, a dump and an `.npmrc` in nested folders were absent from both built images.
- **Container hardening:** the proxy and app run read-only with `cap_drop: ALL` and `no-new-privileges`. Images, CI services and actions are pinned by digest or SHA. Ollama sits on its own internal network with the app only and has no route out while serving; models are pulled by a separate one-shot service that has egress but never sees prompts.
- **Documented, not fixed:** the app does not assert at startup that `DATABASE_URL` connects as the app role; Ollama has no authentication of its own; Postgres and Ollama containers are not read-only or capability-dropped; the decision and create-PR rate limits are in memory per process; a per-IP limiter is still required before the reviewer UI is exposed beyond a private network.
- **Screenshot script (security L-6):** it refuses non-fixture data before approving anything, requires https unless local, prints fixed error codes only, and writes screenshots only when the whole run succeeds.

## Security evidence

Each threat class is mapped to the tests that exercise it. All of them run in `npm test` or `npm run test:db`, which CI runs on every push. The live Ollama tests (`npm run test:ollama`) need a local model and run on a developer machine only. This is test evidence, not a formal audit or penetration test.

| Threat class | Where it is tested (file › test) |
|---|---|
| Malformed or forged webhook events | `webhook-handler.test.ts` › rejects an invalid or missing signature before parsing or enqueueing; rejects signed requests with bad headers, JSON or payload; ignores unsupported events and actions; ignores an installation not on the allowlist. `webhook.test.ts` › rejects a body modified after signing |
| Oversized input | `webhook.test.ts` › readBodyLimited (declared and actual size, streams); `webhook-handler.test.ts` › rejects oversized payloads with 413; `normalize.test.ts` › drops oversized patches, more hunks than the limit; `api-create-pr.test.ts` › refuses oversized bodies; `patches.test.ts` › rejects oversized and broad patches; `docs.test.ts` › skips oversized docs; `llm.test.ts` › refuses a prompt over the provider's input limit |
| Prompt injection and untrusted model output | `llm.test.ts` › sends data only as JSON; prompts tell the model all data is untrusted; the patch model can't name a file; rejects invalid output after the bounded retry. `patches.test.ts` › flags any link, HTML or hidden character in model prose; validatePatch rejections. `pr-content.test.ts` › untrusted values only inside code; hidden characters marked. `ollama.ollama.test.ts` › keeps every invariant on the prompt-injection fixture (live model). Fixture `injection-in-doc` in both evaluations |
| Path traversal, symlinks, unsafe paths | `schemas.test.ts` › repoPathSchema, rejects traversal in docPath; `normalize.test.ts` › rejects unsafe paths by index; `patches.test.ts` › docPathIssues, blank characters rejected in target paths; `docs.test.ts` › refuses symlinks and submodules; `writer.test.ts` › a `PUT` to another path is refused; `publish.db.test.ts` › symlink at the target, a non-tree directory |
| App-role database limits | `grants.db.test.ts` › passes on a migrated database; reports re-granted privileges, a single re-granted binding column, UPDATE on grants and the ledger, database TEMPORARY, schema CREATE, TRUNCATE, and single-column INSERT/UPDATE on whole-table limits |
| Unauthorized access | `review.db.test.ts` › authorized reads, rejected sessions, operator-only accounts; `api.test.ts` › same-origin check; `api-create-pr.test.ts` › cross-site and unauthenticated requests; `publish.db.test.ts` › a requester without the grant, a decider disabled or ungranted; migration 0005 grants |
| Stale or tampered approvals | `review.db.test.ts` › decide (binding, one decision, re-validation); `publish.db.test.ts` › echo mismatch, tampered hash, chain mismatch, forged base, stale head, retargeted PR, changed blob, truncated tree, the output binding changed, extra commits (M-1) |
| GitHub write boundaries | `writer.test.ts` › 22 refused requests at the hook layer, both guard layers on their own, token scope, token revocation (including after the deadline), the token client, no merge method; `publish.db.test.ts` › duplicates, leases, resume |
| Abuse and flooding | `review.db.test.ts` › sign-in rate limit and concurrency cap; `rate-limit.test.ts`; `api.test.ts` › 61st decision request gets 429; `api-create-pr.test.ts` › 11th create-PR request gets 429; `publish.db.test.ts` › early exit, attempt limit |
| Secrets in logs and responses | `webhook-handler.test.ts` › never logs the secret, signature or payload; `llm.test.ts` › logs metadata only; `writer.test.ts` › no token or GitHub message in logs; `api.test.ts` and `api-create-pr.test.ts` › coded 500s that hide the error; `actions.test.ts` › code-only errors |

**Mutation evidence:** controls were removed one at a time and a test had to fail (docs/08). These were run by hand; their logs are not committed.

**Kill switches** (all need a server restart, except reviewer commands):
- **GitHub writes:** `GITHUB_WRITES_ENABLED` not `true`.
- **Webhook intake:** an empty `GITHUB_ALLOWED_INSTALLATION_IDS`, which answers 503.
- **The model:** `OLLAMA_MODEL` unset (deterministic only).
- **A reviewer:** `npm run reviewer:disable`, or `reviewer:revoke` for one grant.

**Rate limits:**
- **Sign-in:** per username (5 failures in 15 minutes) and 4 concurrent.
- **Decisions:** 60 per reviewer per minute.
- **Create-PR:** 10 per reviewer per minute, plus 5 attempts per decision, 30 s apart.
- **Per process:** the decision and create-PR limits live in memory per process.

**Not covered:**
- No fuzzing and no load test.
- Prompt injection is exercised live on one fixture with one small model only.
- No automated test of the deployment: the proxy split, network isolation, init behaviour, image contents and sign-in through the proxy were verified by hand with Docker (docs/10).
- The live GitHub write ran once, without a ruleset (docs/10).

## GitHub workflow cautions

- Do not use privileged `pull_request_target` workflows to check out and execute untrusted PR code.
- Do not expose repository or app secrets to untrusted code.
- Do not automatically merge the generated documentation PR.
- Review third-party GitHub Actions and pin them to immutable commit SHAs.

## Incident response

How to revoke GitHub App credentials, rotate webhook secrets, disable write operations, inspect audit events and restore a known-good deployment: the write-path procedure (stop writes, suspend the installation, rotate the key, lock reviewers, clean up branches and PRs, review `github_outputs` and `github_output_attempts`) is in docs/13 "Incident response". Database restores are in docs/10.
