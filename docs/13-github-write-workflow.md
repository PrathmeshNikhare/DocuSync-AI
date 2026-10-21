# GitHub Write Workflow

Status: **approved and implemented** (design approved 2026-10-12 after a security design review whose required changes were all applied). It is tested against a fetch-level fake of GitHub and the test database, and ran once against a live GitHub App on 2026-10-15 in a private sandbox repository without the required ruleset (docs/10). The design was approved before any write code existed. Decision D-013 records the choices:
- a live CLI analysis path;
- a docs PR stacked on the source PR's head branch;
- fresh approval as an explicit action that echoes back the hashes the reviewer saw;
- the app database role is trusted, within bounds (see "Trust assumption");
- reviewers are named by display name;
- one GitHub App is used for reading and writing.

## Goal and non-goals

- **Goal:** after a reviewer accepts or edits a proposal, an explicit, separate action creates **one** documentation branch, **one** commit changing **one** allowed doc file, and **one** pull request. The approved change is never merged automatically.
- **Non-goals:**
  - merging;
  - more than one file per PR;
  - writing to the default branch, or to any branch other than a new `docusync/…` branch;
  - writing for fixture data;
  - a background runner (still deferred);
  - GitHub OAuth for reviewers.

## Trust assumption (D-013)

- **What a compromised app role can do:** whoever holds the app database role (`DATABASE_URL`) can insert sessions, proposals and decisions. So they can make the App open a bounded docs PR. The PR must be in a repository of an allowlisted installation, change one allowed doc file with a patch that passes `validatePatch`, target the head branch of an open same-repository PR, and is never merged.
- **Accepted:** the user accepted this risk. Signed decisions or HMAC-keyed sessions are not built.
- **Limits that stay in place:**
  - **Repository identity is fixed:** `repositories (github_repo_id, source)` can't be updated by the app role (migration 0005 revokes table-level UPDATE and grants it back on `owner`, `name`, `installation_id` and `updated_at` only). The webhook's upsert still updates `owner`, `name` and `installation_id` after renames and transfers.
  - **The token decides the repository, not the stored name:**
    - each write snapshots `github_repo_id` and `installation_id` onto `github_outputs`;
    - the token is scoped to that repository id;
    - GitHub's own `base.repo.id` must match it.
  - **The decision must match its proposal chain:** proposal → candidate → analysis → pull request → repository must lead to the decision's `repository_id`, `head_sha` and `base_blob_sha` (`APPROVAL_TAMPERED`).
- **Recorded in docs/07** as an accepted risk.

## Writes are off by default

- Every write path requires `GITHUB_WRITES_ENABLED=true` (product invariant, docs/07: "GitHub writes are unavailable by default"). Unset, or any other value, means:
  - the create-PR endpoint answers `503 WRITES_DISABLED`;
  - the UI explains that writes are turned off.
- **Enforced twice:** in the route, and again inside the writer. The writer refuses to build a client, mint a token or issue any mutating call while the flag is off, so no other caller can skip it.
- The flag is read from the server environment at call time. Changing it needs a server restart, as for any env var.

## GitHub permissions and the request guard

- **One App** for reading and writing (user choice). docs/10 recommends a separate write App, and branch rulesets, for deployments that want a stolen read key not to be able to mint write tokens.
- **Reader (extended for the live path):**
  - tokens ask for `pull_requests: read` and `contents: read`, scoped to the one repository named on the command line (`repositoryNames`);
  - the existing guard still refuses any non-GET call.
- **Writer (new, separate module `src/lib/github/writer.ts`):**
  - **Token:**
    - built with a new `createAppAuth` per write operation, because `@octokit/auth-app` caches installation tokens otherwise;
    - asks for `contents: write` and `pull_requests: write`, with `repository_ids: [github_repo_id]`;
    - the response must say exactly those permissions and exactly that one repository, or the operation stops with `GITHUB_TOKEN_SCOPE`;
    - revoked with `DELETE /installation/token` (allowlisted) in a `finally`, on success, every failure and `LEASE_LOST`. The revocation has its own 10 s timeout and ignores the operation's deadline, so it still runs after a timeout. A failed revoke is logged and never masks the operation's own code;
    - never stored or logged.
  - **The token client is guarded too:** it may call only `POST /app/installations/{installation_id}/access_tokens`, with the snapshotted installation id.
  - **Request guard, in two layers.** Both refuse with `GITHUB_WRITE_BLOCKED` before any byte leaves the process.
    1. **Octokit hook:**
       - The call must match one exact `(method, route template)` pair below. Template-less (literal) URLs are refused.
       - `owner` and `repo` must equal the bound repository, and every other parameter must equal its expected value *exactly* (no prefix matching).
       - Request bodies may contain only the listed keys, so no `committer`, `author`, `issue`, or anything else.
       - Per-request `baseUrl`, `headers` and `request.fetch` overrides are refused. `baseUrl` is pinned to `https://api.github.com`.
    2. **Wrapping `fetch`:**
       - Re-checks the real URL: host `api.github.com`, and the method plus decoded pathname against the same allowlist.
       - Sets `redirect: "manual"`; any 3xx is a coded failure (`GITHUB_REDIRECT`), never followed.
  - **Allowlist** (`B` is the docs branch, `H` the decision's `head_sha`, `P` the target path):

    | Method and route | Exact parameters |
    |---|---|
    | `GET /repos/{owner}/{repo}/pulls/{pull_number}` | the source PR number |
    | `GET /repos/{owner}/{repo}/git/trees/{tree_sha}` | non-recursive; `tree_sha` = `H` (the root, resolved through the commit by GitHub), then each sub-tree sha taken from the previous response while walking `P`'s directory segments |
    | `GET /repos/{owner}/{repo}/git/blobs/{file_sha}` | `file_sha` = the decision's `base_blob_sha` |
    | `GET /repos/{owner}/{repo}/git/ref/{ref}` | `ref` = `heads/B` |
    | `POST /repos/{owner}/{repo}/git/refs` | body `{ ref: "refs/heads/B", sha: H }` |
    | `GET /repos/{owner}/{repo}/compare/{basehead}` | `basehead` = `H...<the docs branch tip>` (resume only) |
    | `PUT /repos/{owner}/{repo}/contents/{path}` | `path` = `P`; body exactly `{ message, content, sha: base_blob_sha, branch: B }`. `branch` is **required**, because without it GitHub writes to the default branch |
    | `GET /repos/{owner}/{repo}/pulls` | `head` = `<owner>:B`, `state` = `all` |
    | `POST /repos/{owner}/{repo}/pulls` | body exactly `{ title, body, head: B, base: <recorded head ref>, maintainer_can_modify: false }` |
    | `DELETE /installation/token` | none |

  - **Everything else is refused:** merge endpoints, other deletes, other paths, branches or repositories, GraphQL.
  - **No merge method:** the writer interface has none.
  - **Timeouts:** each request has a 10 s timeout, and the whole operation has a 45 s deadline (an `AbortSignal`), shorter than the 60 s lease.
  - **Error mapping per step.** GitHub's message is never echoed.
    - A 409 or 422 on the `PUT` gives `STALE_BLOB`.
    - A 422 on `git/refs` means the branch already exists: read the ref.
    - A 422 on `POST pulls` means the PR already exists: look it up.
    - A timeout or 5xx on any POST or PUT is an **ambiguous outcome**: the next attempt resumes by re-reading state, never assuming failure.
- **App setup (docs/10):**
  - The App needs Contents read and write and Pull requests read and write.
  - Those permissions also allow pushing to other branches and merging, so the guard and the token scoping are the code-level controls.
  - **Required before setting `GITHUB_WRITES_ENABLED=true`:** a ruleset that lets only the App update `docusync/**` branches, and rulesets that protect the default and release branches with no bypass for the App. The `docusync/**` ruleset is the only control that stops a person with push access from adding commits to the bot's docs branch after its PR opens (security-check M-1), and rulesets are the only control that limits a stolen key.

## Live analysis path (CLI only)

`npm run analysis:run -- --live owner/repo#N --installation <id>`:
1. **Installation:** must be in `GITHUB_ALLOWED_INSTALLATION_IDS`.
2. **Ingest:**
   - The PR is ingested with the read-only reader, with stale-head detection unchanged.
   - The raw PR schema gains `state`, `head.ref`, `head.repo.id` (nullable) and `base.repo.id`.
   - The repository id comes from GitHub's `base.repo.id`, never from the command line.
   - A PR whose `head.repo` is null or differs from `base.repo` is refused (`FORK_NOT_SUPPORTED`).
3. **Fetch the docs at the snapshot's `headSha`** with `GET /git/trees/{headSha}?recursive=1`:
   - keep only blob entries with mode `100644` or `100755` whose path passes `docPathIssues` (root `*.md` or `*.markdown`, or `docs/**`);
   - refuse mode `120000` (symlink) and `160000` (submodule) entries, and note them;
   - skip files over 200,000 bytes or past `DOC_LIMITS.maxDocs` or the total budget, with a note;
   - if GitHub truncates the tree, mark the analysis partial.
4. **Read each blob with `GET /git/blobs/{sha}`:**
   - decode the base64 to bytes;
   - **refuse** a leading `EF BB BF` (checked on the bytes, since `TextDecoder` strips a BOM silently), a NUL byte (Postgres can't store it) and invalid UTF-8 (`TextDecoder` with `fatal: true`). Each is noted and skipped;
   - require `gitBlobSha(text) === tree sha`, and skip on mismatch.
   - This makes `baseBlobSha` GitHub's real blob id at `headSha` (closes the earlier limitation that the blob SHA was the hash of stored text, for live data).
   - `gitBlobSha` is SHA-1 only, so SHA-256 repositories skip every doc. That fails closed.
5. **Run and save:**
   - run `assistImpact`;
   - save under a repository with `source = 'github'`, upserted by `github_repo_id` exactly as the webhook does;
   - save the PR row for `headSha`, now with `head_ref` and `base_ref` (migration 0005).

The webhook still only enqueues (D-009). There is no background runner.

## Approval: what "explicit and fresh" means

- **Who and what:** a reviewer with a grant on the repository opens a decided review (accepted or edited), presses **Create documentation PR…** and confirms an inline confirmation (not a modal dialog). It shows:
  - the repository, the source PR and its head branch;
  - the head SHA, the target file and its blob;
  - **the approved diff itself**, rendered as safe text as in the review page;
  - the approved patch hash.
- **The request:** `POST /api/reviews/:proposalId/create-pr` with a JSON body of exactly `{ headSha, patchSha256 }`, echoing what the dialog showed. It keeps the review API's controls:
  - same-origin check and body limit;
  - `no-store`;
  - the error envelope and coded 500s.
- **Who may press it:** any reviewer with the grant (D-013). It needn't be the one who decided. Every attempt records who pressed it.

## Write-time re-checks

All of these are checked, in this order. The first failure stops the write with a code and **no GitHub write**.
1. **Writes enabled:** `GITHUB_WRITES_ENABLED` is `true` (`WRITES_DISABLED`).
2. **Session:** a valid session, with the reviewer not disabled.
3. **Grant:** the requester still has the grant on the repository, re-read now. Ungranted or unknown ids give `NOT_FOUND`, before any decision state is revealed.
4. **Decision:**
   - one exists and is `accepted` or `edited`;
   - `rejected` gives `PROPOSAL_REJECTED`, and no decision gives `NOT_DECIDED`;
   - the **deciding** reviewer must still be enabled and still granted (`DECISION_REVOKED`).
5. **Echo:** the body's `headSha` and `patchSha256` equal the decision's (`APPROVAL_MISMATCH`).
6. **Chain:** the decision's `repository_id`, `head_sha` and `base_blob_sha` equal those reached through its proposal (`APPROVAL_TAMPERED`).
7. **Patch integrity:** `sha256(edited_patch ?? patch_text)` equals the stored `patch_sha256` (`APPROVAL_TAMPERED`).
8. **Validation:** `validatePatch` passes again on the approved patch with the stored context (`PATCH_INVALID`).
9. **Repository:**
   - `source = 'github'` (`FIXTURE_NOT_WRITABLE`);
   - its `installation_id` is allowlisted (`INSTALLATION_NOT_ALLOWED`);
   - the PR row has a recorded `head_ref` and `base_ref` (`ANALYSIS_TOO_OLD`).
10. **Attempts:** fewer than 5 attempts so far, and at least 30 s since the last one (`ATTEMPT_LIMIT`, `RETRY_TOO_SOON`).
11. **On GitHub, through the writer with a fresh token:**
    - the PR is open (`PR_NOT_OPEN`);
    - the PR's `base.repo.id` equals the snapshotted `github_repo_id` (`REPOSITORY_MISMATCH`);
    - `head.repo` is non-null and `head.repo.id` equals `base.repo.id` (`FORK_NOT_SUPPORTED`);
    - `head.sha` equals the decision's `head_sha` (`STALE_HEAD`);
    - `head.ref` equals this output's `docs_pr_base_ref` snapshot and `base.ref` equals the recorded `base_ref` (`PR_RETARGETED`);
    - walking `P`'s segments through non-recursive trees from `head_sha`, every directory is a `tree` entry and the final entry has mode `100644` or `100755` and sha `base_blob_sha` (`STALE_BLOB`). A truncated tree gives `TREE_TRUNCATED`.
12. **The content that will be written (H1):**
    - fetch the blob bytes for `base_blob_sha`, with the live path's BOM, NUL and UTF-8 rules;
    - require `gitBlobSha(bytes) === base_blob_sha` **and** the decoded text equals the stored `base_content` (`APPROVAL_TAMPERED`);
    - apply the approved patch to that text and re-run `validatePatch` on the result. As implemented, `validatePatch` runs on the approved patch against the stored text, and the fetched text must equal the stored text exactly, so validating against the fetched text gives the same result;
    - the `PUT` sends **exactly** that result, so a forged or drifted stored base can never become the written file.
13. **The commit itself:** the Contents `PUT` sends `sha = base_blob_sha`, so GitHub refuses (409 or 422) if the file changed between checks (`STALE_BLOB`).

## Idempotency, leases and partial failure

- **Migration 0005, `github_outputs`:** one row per decision (`UNIQUE (decision_id)`, FKs `ON DELETE RESTRICT`).
  - **Binding columns (set once):**
    - `id`, `decision_id`, `proposal_id`, `repository_id`;
    - `github_repo_id`, `installation_id`;
    - `head_sha`, `base_blob_sha`, `patch_sha256`;
    - `branch`, `docs_pr_base_ref` (the docs PR's base, which is the source PR's head ref);
    - `created_by`.
  - **Mutable columns:**
    - `step` (`pending`, `branch_created`, `committed`, `pr_opened`);
    - `error_code` (the last failure, cleared on success, and kept apart from `step` so a retry knows where to resume);
    - `commit_sha`, `pr_number`, `pr_url`;
    - `attempts`;
    - `lease_token`, `lease_until`;
    - `updated_at`.
  - **Checks:**
    - `pr_url` must match `^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+$`, validated before storing and rendering;
    - `pr_number` and `pr_url` are set exactly when `step = 'pr_opened'`.
  - **App role:** migration 0005 revokes table-level UPDATE, DELETE and TRUNCATE (the default privileges grant them), then grants UPDATE on the mutable columns only. A column-level revoke alone would do nothing while table-level UPDATE remains.
- **`github_output_attempts`:** one row per press, `(output_id, reviewer_id, at)`. Migration 0005 revokes UPDATE, DELETE and TRUNCATE on it from the app role, so it is append-only, and it is the audit of who requested each attempt.
- **Migration 0005 also adds:**
  - `pull_requests.head_ref` and `pull_requests.base_ref` (nullable). A live run sets them, and refreshes them when they differ, even on a row the webhook or an earlier run created (`ON CONFLICT … DO UPDATE … WHERE (head_ref, base_ref) IS DISTINCT FROM …`). So a retargeted PR can be analysed and reviewed again without a new commit. Outputs already requested keep their own `docs_pr_base_ref`;
  - on `repositories`: `REVOKE UPDATE … FROM docusync_app`, then `GRANT UPDATE (owner, name, installation_id, updated_at)`, exactly what the webhook upsert sets.
- **Claiming:**
  - insert ON CONFLICT DO NOTHING;
  - then take the lease with a random `lease_token`: `UPDATE … SET lease_token = $t, lease_until = now() + 60 s, attempts = attempts + 1 WHERE … AND (lease_until IS NULL OR lease_until < now())`;
  - a request that can't take it gets `409 IN_PROGRESS`.
  - Every later state update is `… WHERE id = $1 AND lease_token = $2 AND lease_until > now()`. Zero rows means the lease was lost, so the operation stops without further GitHub calls (`LEASE_LOST`).
  - No database transaction stays open across GitHub calls.
- **The steps.** Each is persisted after it succeeds. A retry runs all re-checks again, then resumes from `step`.
  1. **Branch:**
     - The name is `docusync/pr-<number>-<first 12 hex of the proposal id>`, created at `head_sha`.
     - On 422 (exists), read the ref. Continue only if it equals `head_sha` (before a commit) or the recorded `commit_sha` (after one). Anything else gives `BRANCH_CONFLICT`.
  2. **Commit:**
     - If `commit_sha` is recorded, the branch tip must equal it.
     - Otherwise, if the tip equals `head_sha`, `PUT` the content, then record `commit_sha` from the response. The `PUT` is conditioned on the file's blob, not on the branch tip, so the response's commit must have exactly one parent, `head_sha`. If someone pushed to the branch in between, GitHub committed on top of their commit, and the write stops with `BRANCH_CONFLICT` (security-check M-1).
     - If the tip is something else after an ambiguous `PUT`, adopt it only if `compare H...tip` shows exactly one commit, whose single parent is `H`, changing exactly one file (the target path, status `modified`) to blob `gitBlobSha(new content)`. Otherwise `BRANCH_CONFLICT`.
  3. **PR:**
     - Re-read the branch ref; it must equal `commit_sha`. Then `compare H...commit_sha` must show exactly our change: one commit, parent `H`, one file, the target, at the approved blob. This is the same check used to adopt a lost commit.
     - List PRs with `head = owner:B`, state all. Adopt one only if all of these hold, otherwise `BRANCH_CONFLICT`:
       - its author is the App's bot (`user.login` = `<GITHUB_APP_SLUG>[bot]`);
       - `base.ref` equals `docs_pr_base_ref`;
       - `head.sha` equals `commit_sha`;
       - `head.repo.id` equals `github_repo_id`.
     - If none exists, create it with `base` = `docs_pr_base_ref` and `maintainer_can_modify: false`. The created PR's `head.sha` must equal `commit_sha`. Otherwise someone pushed between the last check and the create: the PR exists but carries more than our commit, so it is not recorded, and the code is `PR_HEAD_MISMATCH` (terminal; an operator closes that PR). A 422 on create goes back to the lookup. If no PR of ours is found, the code is `PR_CREATE_REFUSED` (for example, the base branch was deleted). An unusable response to a create or a `PUT` is `GITHUB_AMBIGUOUS`: the next attempt re-reads GitHub and adopts what was made, through the same checks.
- **Retries:**
  - A `pr_opened` row answers with the stored PR URL and never creates another. This happens right after the session and grant checks, before the approval checks, so the PR is still reported after its approver was disabled. An adopted PR may be closed, so the UI shows the PR link without claiming it is open. A PR adopted rather than created by this request is reported with `created: false` (HTTP 200).
  - A row whose last error is retryable can be retried, within the attempt limit. Retryable: GitHub timeouts, network and 5xx errors, rate limits, 401/403/404 from GitHub, a refused or wrongly scoped token (`GITHUB_TOKEN_REFUSED`, `GITHUB_TOKEN_SCOPE`: credentials or installation being fixed), redirects (`GITHUB_REDIRECT`: a renamed repository until the webhook records the new name), `GITHUB_AMBIGUOUS`, `WRITES_DISABLED`, `LEASE_LOST` and `INTERNAL_ERROR`.
  - Non-retryable codes need a new analysis and review: stale, mismatch, tampered, rejected, conflict, `PR_CREATE_REFUSED`. The API says so in its message (a 502 for a terminal GitHub code reads differently from a retryable one).
- **Configuration first:** the route validates the App id and key, `GITHUB_APP_SLUG` and the installation allowlist before calling the publish flow (`503 WRITES_MISCONFIGURED` otherwise). Stored evidence and model metadata are parsed before the claim. A misconfiguration or corrupt row costs no attempt and mints no token. An unexpected error after the claim releases the lease and records `INTERNAL_ERROR` (retryable).
- **New env var:** `GITHUB_APP_SLUG` (`^[a-z0-9-]{1,100}$`), required only when writes are enabled.

## PR content (untrusted text handled)

- **Untrusted values:** every value that came from the PR, the model or an operator: paths, the head ref, the model name, the rationale, excerpts and the reviewer's display name.
- **Code spans:** each untrusted value is rendered only inside an inline code span or a fenced block whose fence is longer than any backtick run in the value. Newlines are removed from inline values, and a value that starts or ends with a backtick or is only spaces gets CommonMark space padding. So no Markdown, HTML, link, `@mention` or `#123` reference in them is interpreted.
- **Links:**
  - only `<https://github.com/…>` autolinks, built from server values and URL-encoded path segments;
  - no untrusted link text, ever;
  - evidence lines show `` `path:line` `` followed by its autolink at `head_sha`.
- **Title:** `docs: update <target path> for #<number>`, with `@` and `#` in the path neutralized by a zero-width joiner (titles aren't code-spanned).
- **Body:**
  - the source PR (`#<number>`);
  - DocuSync's commit SHA, and the statement that the PR should contain exactly that one commit and that any other commit was not reviewed in DocuSync;
  - the reviewer's **display name** (in a code span) and decision. Usernames are never published;
  - the approved patch hash, the head SHA and the base blob;
  - the validation result;
  - the evidence;
  - the model metadata;
  - the model rationale (in a fenced block) only if it passes `proseIssues`, otherwise the withheld notice;
  - the line "Generated by DocuSync AI. Review before merging; it is never merged automatically.";
  - a note that this PR targets the source PR's head branch, and that if that branch is force-pushed later, this PR may show or reintroduce old commits.
- **Cap:** the body is cut at 60,000 characters on a line boundary, closing any open fence.
- **Commit message:** `docs: update <target path> (DocuSync AI)`, with the path neutralized as in the title.

## Logging and secrets

- **`logEvent` fields** gain `outputId` and `reviewerId` (opaque ids). Each attempt logs the request id, output id, reviewer id, step and code.
- **Never logged:** tokens, the private key, patch text, file content, PR bodies or GitHub error messages.
- **Server-only secrets:** the private key is read only on the server (the `server-only` env module) and never sent to the client. Tokens live in memory for one operation, then are revoked.

## Incident response

To stop writes and contain damage:
1. **Stop writes:** set `GITHUB_WRITES_ENABLED` to anything but `true` and restart the server.
2. **Suspend the installation:** suspend the App's installation in GitHub settings, or uninstall it. This stops every token at once.
3. **Rotate the key:** if the key may be exposed, generate a new App private key, deploy it, and delete the old one in GitHub.
4. **Lock reviewers:** disable suspect reviewers (`npm run reviewer:disable`) and revoke grants (`npm run reviewer:revoke`). Disabling also blocks their earlier decisions from being published (`DECISION_REVOKED`).
5. **Clean up GitHub:** close the bot's open PRs and delete leftover `docusync/…` branches by hand. The App never deletes them. A `PR_HEAD_MISMATCH` always leaves a PR to close; check any bot PR whose commit list differs from the commit named in its body.
6. **Review the evidence:** check `github_outputs`, `github_output_attempts` and the logs for what was written and by whom.

## Follow-ups to the review UI

- **Operator commands:**
  - `reviewer:revoke` removes a grant;
  - `reviewer:disable` and `reviewer:enable`;
  - `sessions:prune` deletes expired or revoked sessions with the owner role.
- **Session cap:** a sign-in revokes the oldest sessions beyond 10 per reviewer.
- **No password on stdout:** `reviewer:add --password-file <path>`
  - writes the generated password to a new file;
  - refuses an existing file;
  - prints only the path.
  - The file is created with mode 0600, which Windows ignores; protect it with filesystem ACLs there.
- **Code-only error logging:** page loaders and Server Actions catch unexpected errors, log only a code, and rethrow a generic error.

## Tests (GitHub mocked at `fetch`, plus the test database)

- **No write without approval:**
  - writes disabled, both at the route and in the writer;
  - no session;
  - grant revoked;
  - an ungranted id gives `NOT_FOUND`;
  - no decision;
  - rejected;
  - decider disabled or ungranted;
  - echo mismatch;
  - tampered patch;
  - a decision whose binding disagrees with its proposal;
  - invalid patch;
  - a fixture repository;
  - an installation not on the allowlist;
  - the attempt limit and the retry interval.
- **Grants (migration 0005):** as the app role, `UPDATE repositories SET github_repo_id = …` and `… SET source = …` are denied, the webhook upsert still works, and UPDATE of a binding column, DELETE or TRUNCATE on `github_outputs`, and any UPDATE or DELETE on `github_output_attempts`, are denied.
- **Refs backfill:** a live run for a head the webhook already recorded fills `head_ref` and `base_ref`.
- **Forged base (H1):** a stored `base_content` that differs from the real blob, with a correct `base_blob_sha`, is refused before any GitHub request with `PATCH_INVALID`, because `validatePatch` requires `gitBlobSha(base_content) === base_blob_sha`. GitHub blob bytes that don't hash to their id, or that carry a BOM, give `APPROVAL_TAMPERED` and no `PUT`. The text-equality check after the hash check is defence in depth: it can't fail without a SHA-1 collision. The `PUT` content equals the patch applied to the fetched blob.
- **Stale state:**
  - PR closed;
  - head moved;
  - PR retargeted;
  - blob changed;
  - symlink at the target;
  - truncated tree;
  - a directory segment that is not a tree;
  - GitHub 409 or 422 on the `PUT`;
  - a fork, including a deleted one (`head.repo` null);
  - a repository id mismatch.
- **Token:**
  - a fresh token per operation;
  - a scope mismatch in the token response is refused;
  - the token is revoked on success and on every failure path, including after the operation's deadline has fired, without masking the failure code;
  - a refused token request is `GITHUB_TOKEN_REFUSED` and can be retried once the App is fixed.
- **Idempotency:**
  - sequential duplicates give one PR;
  - concurrent duplicates give one PR plus `IN_PROGRESS`;
  - a `pr_opened` row returns the same URL;
  - a lost lease stops further writes.
- **Partial failure:**
  - the branch is created but the commit fails, and a retry resumes;
  - the commit's response is lost, and a retry adopts it only after the compare check;
  - the commit succeeds but PR creation fails, and a retry opens the PR once;
  - PR creation succeeded but the response was lost, and a retry finds the bot's PR.
- **Branch tampering:**
  - an extra commit on the docs branch gives `BRANCH_CONFLICT`;
  - a PR on our branch by someone else is not adopted.
- **Guard:**
  - merge, delete, another path, another branch, another repository and GraphQL are refused before `fetch`;
  - a literal URL, a `baseUrl` override, a header override and a 307 redirect are refused;
  - a `PUT` without `branch` is refused;
  - a near-miss branch name is refused;
  - a wrong `sha` on `git/refs` is refused;
  - extra body keys are refused;
  - the token client can't call anything but the token endpoint;
  - no merge method exists.
- **PR body:** paths, rationale, a display name and a head ref carrying `](…)`, HTML, backticks, `@team` and `#1` render inert; the cap closes the fence.
- **Redaction:** no token, key, patch text or GitHub message in logs or responses.
- **Live path:**
  - a symlink or submodule entry is refused;
  - invalid UTF-8, a BOM or a NUL is refused;
  - a blob SHA mismatch is skipped;
  - a truncated tree marks the analysis partial;
  - a fork or deleted fork is refused;
  - size limits apply.

## Residual risks and follow-ups

- **Over-broad permissions:**
  - the App's Contents write permission is repository-wide, and the same App reads and writes (user choice);
  - the guard and the token scoping limit what this code does, not what a stolen private key could do;
  - rulesets and a separate write App are the stronger controls (docs/10).
- **Pushes after the PR opens:** DocuSync checks its commit until the PR is created, and names it in the PR body. After that, only the `docusync/**` ruleset keeps others from adding commits to the bot's branch (required in docs/10).
- **App database role:** compromising it allows bounded docs PRs (accepted; see "Trust assumption").
- **Script CSP:** `script-src 'unsafe-inline'` (D-012) now protects a write-capable action. The echo and the dialog don't defend against script injection, so the UI must keep rendering no untrusted HTML. Re-assessing a nonce or hash CSP is a follow-up.
- **Decision age:** decisions don't expire. Freshness rests on the head, blob and branch checks.
- **Diff pinning:** the PR file list is still fetched by PR number, not pinned to a commit (the A→B→A gap). Docs are pinned at `headSha`. A compare-based pin is a follow-up.
- **Moving base branch:** the stacked base is the source head branch. If it moves after the checks, the docs PR is computed against the recorded head. GitHub shows the real diff, and a human reviews before merging.
- **Actions minutes:** pushes and PRs made with an App token run the target repository's workflows. That costs Actions minutes but adds no new execution privilege.
- **Run live once (2026-10-15):** the read path and one write (branch, commit, PR) ran against a live App in a private sandbox (docs/10), without the required ruleset. Everything else here is still verified against mocks only: retries, revocation, branch movement and incident response.

## Hardening after the first design

- **Early answers:** an existing output that is locked, terminal, at its attempt limit or retried too soon is answered from its row before the approval is re-checked (security-check L-3).
- **Per-reviewer limits:** 10 create-PR requests per minute.
- **Resume re-checks the binding:** a resumed output's stored `head_sha`, `base_blob_sha` and `patch_sha256` must equal the approval's (`APPROVAL_TAMPERED`, `/review` L3).
- **Logging:** each attempt logs the step it reached (L6).
- **Hidden characters:** invisible and bidi characters in PR text appear as `[U+XXXX]` (L-2).
- **Behind a TLS proxy:** set `APP_ORIGIN` (docs/10).
