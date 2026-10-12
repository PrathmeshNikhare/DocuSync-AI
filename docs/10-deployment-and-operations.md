# Deployment and Operations

## Local development

- Use a supported Node.js LTS release compatible with the chosen Next.js version.
- Store secrets in ignored local environment files; commit only `.env.example` with placeholder values.
- Run PostgreSQL locally, e.g. with Docker Compose.
- Run Ollama locally; keep its endpoint private and configurable.
- Apply SQL migrations before starting the app.
- Document exact setup and verification commands in README after they are tested.

## GitHub App setup (Phase 01, read-only)

1. Create a GitHub App, and set **Where can this GitHub App be installed?** to **Only on this account** (private). A public App would let anyone queue work. Repository permissions: **Pull requests: Read-only** and **Metadata: Read-only** (mandatory). For live analyses (Phase 05) add **Contents: Read-only**. Grant no write permissions unless you enable GitHub writes (next section).
2. Subscribe to the **Pull request** event. Set the webhook URL to `https://<host>/api/webhooks/github` and a random secret of at least 20 characters (store it as `GITHUB_WEBHOOK_SECRET`).
3. Generate a private key and store it as `GITHUB_APP_PRIVATE_KEY`, either as a one-line PEM with `\n` escapes or as a quoted multi-line value. Set `GITHUB_APP_ID`.
4. Install the App on a test repository. The installation id is in the webhook payload (`installation.id`) and in the App's installation URL. Add it to `GITHUB_ALLOWED_INSTALLATION_IDS` (comma-separated). Deliveries from any other installation are ignored, and the webhook returns 503 until the allowlist is set.
5. Check it with `npm run ingest -- --live owner/repo#<number> --installation <id>`.

Even if the App is granted more permissions, the reader requests tokens with `pull_requests: read` only.

## GitHub writes (Phase 05, off by default)

Design: docs/13. Writes stay off unless `GITHUB_WRITES_ENABLED=true`; any other value, or none, disables them. Changing it needs a server restart.
1. **Permissions:** to enable writes, give the App **Contents: Read and write** and **Pull requests: Read and write**. GitHub grants those for whole repositories (any branch, and merging). The code limits each operation to one repository, one new `docusync/…` branch, one file and one PR, never merges, and mints a fresh token per operation that it revokes afterwards. A stolen private key is limited only by GitHub-side controls, so:
   - **Rulesets (required before enabling writes):** restrict updates to `docusync/**` to the App, so nobody else can add commits to a bot-authored docs PR (security-check M-1). Protect the default and release branches with no bypass for the App. The code can't check these settings; the operator must.
   - **A separate write App (recommended for higher assurance):** this deployment uses one App for reading and writing (D-013). A second App holding only the write permissions would keep a leaked webhook/read key from minting write tokens. It is not built.
2. **Configuration:** set `GITHUB_APP_SLUG` to the App's slug (its bot is `<slug>[bot]`; only PRs authored by it are ever adopted). `GITHUB_ALLOWED_INSTALLATION_IDS` limits which installations can be written to, as for the webhook.
3. **Live analyses:** `npm run analysis:run -- --live owner/repo#<number> --installation <id>` analyses a same-repository PR (forks are refused), reading docs at its head commit. Only these analyses can be published. Fixture analyses never are.
4. **Publishing:** a granted reviewer opens an accepted or edited review, presses **Create documentation PR…** and confirms. The PR targets the source PR's head branch and is never merged automatically.
5. **Incident response:** follow docs/13 "Incident response":
   - set `GITHUB_WRITES_ENABLED=false` and restart;
   - suspend the installation;
   - rotate the private key;
   - `npm run reviewer:disable` / `reviewer:revoke`;
   - close the bot's PRs and delete leftover `docusync/` branches by hand;
   - review `github_outputs` and `github_output_attempts`.

Not verified against a live GitHub App in this repository: writes were tested against a fetch-level fake of GitHub only.

### Failed webhook deliveries

GitHub does not redeliver failed deliveries automatically. If the endpoint returns 5xx or doesn't answer within 10 s (for example, while the database is down), that delivery is lost. Redeliver it from the App's **Advanced → Recent deliveries** page within 3 days. Redelivery is safe because enqueueing is idempotent. An automated reconciliation job is planned for the runner phase.

### Credentials per process

`MIGRATION_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` belong to the schema owner and can change the schema. Locally they sit in `.env.local`, which `next dev` also loads. In any deployed environment, the web app must receive only `DATABASE_URL` (the `docusync_app` role); run migrations from a separate job that alone has the owner URL.

## Reviewer accounts (Phase 04)

- `npm run reviewer:add -- --username <name> --name "<display name>" --password-file <new file>` creates a reviewer and writes a generated password to a new file (it refuses an existing file and never prints the password). The file gets mode 0600 on POSIX; on Windows, protect it with ACLs and delete it once the password is handed over. `npm run reviewer:grant -- --username <name> --repo <owner>/<repo>` gives them access to one repository. Both use the owner role (`MIGRATION_DATABASE_URL`), because the app role cannot write accounts or grants.
- `npm run reviewer:disable -- --username <name>` disables a reviewer; their sessions stop working on the next request. `reviewer:enable` undoes it. `npm run reviewer:revoke -- --username <name> --repo <owner>/<repo>` removes one grant.
- `npm run sessions:prune` deletes expired and revoked sessions. A sign-in revokes that reviewer's oldest sessions beyond 10.
- `npm run analysis:run -- --fixture <name>` saves a labelled fixture analysis for demos and testing.
- In production the session cookie is `__Host-docusync_session` and requires HTTPS. In development it's `docusync_session` over http.
- `npm run reviewer:unlock -- --username <name>` clears a reviewer's failed sign-ins after a lockout (owner role).
- **Before exposing the review UI:**
  - put a per-IP rate limiter on `/login` in the proxy (the app limits per username and to 4 concurrent sign-ins per process);
  - serve it over HTTPS only (production sends HSTS);
  - forward the browser's host and scheme unchanged, because the decision API's origin check compares them.

## Deployment considerations

- A hosted Next.js deployment cannot reach a developer's localhost Ollama service.
- Serverless request handlers may time out on long-running model analysis.
- Use a private model host or a separate worker when needed; don't expose Ollama publicly.
- Store secrets in the deployment platform's secret manager.
- Use a production database with backups, migrations and least-privilege credentials.
- Configure GitHub App callback/webhook URLs and permissions deliberately.
- Start with read-only GitHub access; enable write permissions only after the approval workflow and security tests pass.

## Observability

Record request/analysis IDs, durations, status, retry count, model/provider and safe error codes. Do not log tokens, webhook secrets, full private repository contents or unredacted prompts by default.

## Operational controls

Provide a kill switch to disable model calls and a separate switch to disable GitHub writes. Document credential rotation and recovery.
