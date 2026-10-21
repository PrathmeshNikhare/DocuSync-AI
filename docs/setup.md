# Local Setup and Walkthroughs

How to run DocuSync AI on your machine, with fixtures first (no GitHub App, no model) and then with the optional model and GitHub integration. Deployment is in docs/10; the demo script is in docs/11.

## Prerequisites

- **Node.js 24** (see `.nvmrc`; `package.json` requires `>=24 <25`).
- **Docker**, for the local PostgreSQL container.
- **Optional:** [Ollama](https://ollama.com) with a model, for model-written assessments and patches. Models are downloaded by Ollama at your request and are **not** shipped with this repository. Each model has its own license (for example, the Llama models used in the evaluation carry Meta's Llama community license); check the terms of any model you pull.
- **Optional:** a private GitHub App, for live analyses and documentation PRs (docs/10).

## First run

```bash
npm ci
cp .env.example .env.local      # placeholders only; never commit real values
docker compose up -d --wait postgres   # first start creates docusync_app and docusync_test
npm run db:migrate              # applies migrations/ as the schema owner
npm run dev                     # http://localhost:3000, health: /api/health
```

Set `GITHUB_WEBHOOK_SECRET` (20+ characters) and `GITHUB_ALLOWED_INSTALLATION_IDS` in `.env.local` only if you want to receive webhooks. Verification commands (`format:check`, `lint`, `typecheck`, `test`, `test:db`, `build`) are in docs/development.md.

**Environment variables.** `.env.example` lists every variable with a comment. The npm scripts read `.env.local` only, and Next.js lets `.env.local` override `.env`, so keep every `GITHUB_*` value in `.env.local`: an empty value there silently wins over a real one in `.env` (the create-PR route then answers `WRITES_MISCONFIGURED`). The passwords in `.env.example` and `docker-compose.yml` are well-known local placeholders; never reuse them anywhere else.

**Database notes.**
- The container binds `127.0.0.1` only. If another PostgreSQL already listens on port 5432, `docker compose up` fails with "ports are not available". Put `POSTGRES_HOST_PORT=55432` (or any free port) in an ignored `.env` file, which docker compose reads, and use the same port in the URLs in `.env.local`.
- The init script in `db/init/` runs only when the data volume is first created. If you created the volume before it existed, recreate it with `docker compose down -v` (this deletes all local data in it).

## Walkthrough 1: fixture ingestion (no credentials)

```bash
npm run ingest -- --fixture env-var-change   # prints the normalized snapshot as JSON
```

The fixtures in `fixtures/github/` are synthetic. Live mode (`npm run ingest -- --live owner/repo#123 --installation <id>`) needs a GitHub App (docs/10).

## Walkthrough 2: deterministic impact analysis

```bash
npm run analyze -- --fixture env-var-renamed   # candidate docs with evidence, as JSON
npm run eval:impact                            # regenerates docs/evaluation/impact-baseline.md
```

The engine is deterministic. The baseline numbers describe the synthetic fixtures only (docs/08).

## Walkthrough 3: model assessment and patch proposals

```bash
npm run propose -- --fixture env-var-renamed   # deterministic result + model assessment + validated patch, as JSON
npm run eval:llm                               # model-assisted vs deterministic; writes docs/evaluation/llm-assisted.md
npm run test:ollama                            # opt-in tests against a real Ollama
```

These need a local Ollama and `OLLAMA_MODEL` (for example `llama3.2:3b`) in `.env.local`. Without `OLLAMA_MODEL`, `propose` prints a deterministic-only result. Proposals are printed, never applied or written anywhere (docs/06).

## Walkthrough 4: reviewing proposals in the browser

```bash
npm run reviewer:add -- --username alice --name "Alice Example" --password-file ./alice.pw   # writes a generated password to a new file
npm run analysis:run -- --fixture env-var-renamed                       # runs the pipeline on a fixture and saves it
npm run reviewer:grant -- --username alice --repo fixture/env-var-renamed
npm run dev                                                             # sign in at http://localhost:3000/login
```

`reviewer:add` and `reviewer:grant` (and `reviewer:revoke`, `reviewer:disable`, `reviewer:enable`, `reviewer:unlock`, `sessions:prune`) use the owner role (`MIGRATION_DATABASE_URL`): the app's own role can't create accounts or grant access. `analysis:run` uses the model when `OLLAMA_MODEL` is set; without it the analysis is deterministic-only and has no patches to review. Fixture analyses are labelled as fixture data everywhere in the UI. Accepting a patch records a decision; nothing is written to GitHub. `*.pw` files are git-ignored; delete the file once the password is handed over.

## Walkthrough 5: documentation pull requests (off by default)

GitHub writes need `GITHUB_WRITES_ENABLED=true`, `GITHUB_APP_SLUG`, and an App with Contents and Pull requests read and write (docs/10, docs/13). Only live analyses can be published:

```bash
npm run analysis:run -- --live owner/repo#123 --installation 987654      # same-repository PRs only
```

After a reviewer accepts or edits a proposal, **Create documentation PR…** opens one PR with that change against the source PR's head branch, after re-checking the approval and GitHub's current state (docs/13). It is never merged automatically. Use a throwaway repository: this path has run live once, without the recommended ruleset (docs/10).

## Sending a test webhook locally

With `GITHUB_ALLOWED_INSTALLATION_IDS=987654` (the fixture's installation), sign `fixtures/webhooks/pull_request.opened.json` with your `GITHUB_WEBHOOK_SECRET` (HMAC-SHA256 of the exact file bytes), and POST it to `/api/webhooks/github` with the headers `x-github-event: pull_request`, `x-github-delivery: <uuid>` and `x-hub-signature-256: sha256=<hex>`. The first delivery returns 202 `queued`; sending it again returns 200 `duplicate`. Webhooks only enqueue an analysis; nothing processes the queue (D-009).

## Reference deployment

```bash
docker compose -f deploy/compose.yml up -d --build --wait   # reference private-network deployment (docs/10)
```

It needs the three `deploy/*.env` files copied from the `*.env.example` placeholders (docs/10). It has been verified locally with Docker only, not on a hosted environment.

## Screenshots

`npm run screenshots` drives the real UI with Playwright and writes `docs/assets/screenshots/*.png` (docs/11). It approves a fixture proposal as the signed-in reviewer, so it refuses anything not labelled as fixture data.
