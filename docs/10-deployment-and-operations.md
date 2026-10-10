# Deployment and Operations

## Local development

- Use a supported Node.js LTS release compatible with the chosen Next.js version.
- Store secrets in ignored local environment files; commit only `.env.example` with placeholder values.
- Run PostgreSQL locally, e.g. with Docker Compose.
- Run Ollama locally; keep its endpoint private and configurable.
- Apply SQL migrations before starting the app.
- Document exact setup and verification commands in README after they are tested.

## GitHub App setup (Phase 01, read-only)

1. Create a GitHub App, and set **Where can this GitHub App be installed?** to **Only on this account** (private). A public App would let anyone queue work. Repository permissions: **Pull requests: Read-only** and **Metadata: Read-only** (mandatory). Phase 02 is expected to add **Contents: Read-only**. Grant no write permissions.
2. Subscribe to the **Pull request** event. Set the webhook URL to `https://<host>/api/webhooks/github` and a random secret of at least 20 characters (store it as `GITHUB_WEBHOOK_SECRET`).
3. Generate a private key and store it as `GITHUB_APP_PRIVATE_KEY`, either as a one-line PEM with `\n` escapes or as a quoted multi-line value. Set `GITHUB_APP_ID`.
4. Install the App on a test repository. The installation id is in the webhook payload (`installation.id`) and in the App's installation URL. Add it to `GITHUB_ALLOWED_INSTALLATION_IDS` (comma-separated). Deliveries from any other installation are ignored, and the webhook returns 503 until the allowlist is set.
5. Check it with `npm run ingest -- --live owner/repo#<number> --installation <id>`.

Even if the App is granted more permissions, the reader requests tokens with `pull_requests: read` only.

### Failed webhook deliveries

GitHub does not redeliver failed deliveries automatically. If the endpoint returns 5xx or doesn't answer within 10 s (for example, while the database is down), that delivery is lost. Redeliver it from the App's **Advanced → Recent deliveries** page within 3 days. Redelivery is safe because enqueueing is idempotent. An automated reconciliation job is planned for the runner phase.

### Credentials per process

`MIGRATION_DATABASE_URL` and `TEST_MIGRATION_DATABASE_URL` belong to the schema owner and can change the schema. Locally they sit in `.env.local`, which `next dev` also loads. In any deployed environment, the web app must receive only `DATABASE_URL` (the `docusync_app` role); run migrations from a separate job that alone has the owner URL.

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
