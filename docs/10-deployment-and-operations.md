# Deployment and Operations

## Local development

- Use a supported Node.js LTS release compatible with the chosen Next.js version.
- Store secrets in ignored local environment files; commit only `.env.example` with placeholder values.
- Run PostgreSQL locally, e.g. with Docker Compose.
- Run Ollama locally; keep its endpoint private and configurable.
- Apply SQL migrations before starting the app.
- Document exact setup and verification commands in README after they are tested.

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
