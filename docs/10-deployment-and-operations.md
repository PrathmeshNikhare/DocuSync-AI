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
5. Check it with `npm run ingest -- --live owner/repo#<number> --installation <id>`. The npm scripts load `.env.local` only (not `.env`), so put the `GITHUB_*` values there; set `OLLAMA_MODEL` too for proposals. The private key must include its `-----BEGIN … PRIVATE KEY-----` and `-----END …-----` lines.

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

Verified against a live GitHub App on 2026-10-15, read path only: a private sandbox repository, a private App installed on it, `npm run ingest -- --live` and `npm run analysis:run -- --live` on a same-repository PR (an env var rename). The deterministic engine flagged the right doc (`likely_affected`, rules `env_var_removed` and `undocumented_env_var`). With `llama3.2:3b` the proposed patch was rejected by the validator (`EDIT_FIND_NOT_FOUND`) in 3 runs, so no proposal reached review. **GitHub writes have still never run live:** the branch, commit and PR calls were tested against a fetch-level fake only.

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

## Reference private-network deployment (Phase 06, D-014)

`Dockerfile` and `deploy/compose.yml` describe one host running the app, Postgres and an optional Ollama behind a TLS proxy (Caddy). This is a reference setup verified locally with Docker on 2026-10-12. It is **not** a hosted deployment, and none was made.

**What runs where:**

| Service | Networks | Published | Receives |
|---|---|---|---|
| `proxy` (Caddy), public site | `edge` | `127.0.0.1:8443 → 443`. On a real host publish 443 (and 80 for certificates). It serves **only** `/api/webhooks/github`; every other path is 404 | nothing secret |
| `proxy` (Caddy), reviewer UI site | `edge` | `127.0.0.1:8444 → 8444`. **Never publish it to the internet**: expose it only on a private interface, a VPN or an SSH tunnel | nothing secret |
| `app` (image target `runtime`, production dependencies only) | `edge`, `private` | no | `deploy/app.env`: app-role `DATABASE_URL`, GitHub and Ollama settings, `APP_ORIGIN` |
| `migrate` (one-shot, image target `build`) | `private` | no | `deploy/migrate.env`: the owner URL only; runs `db:migrate` then `db:check-grants` |
| `postgres` | `private` (internal: no route out) | no | `deploy/postgres.env`: owner password, `APP_DB_PASSWORD` |
| `ollama` (profile `model`, optional) | `private` only: no route out while it serves prompts | no | no secrets |
| `ollama-pull` (profile `model-pull`, one-shot) | `model-egress` only | no | no prompts; downloads a model onto the shared volume, then exits |

**Run it:**

```bash
cp deploy/app.env.example deploy/app.env              # fill in; deploy/*.env is git-ignored
cp deploy/migrate.env.example deploy/migrate.env
cp deploy/postgres.env.example deploy/postgres.env
docker compose -f deploy/compose.yml up -d --build --wait
docker compose -f deploy/compose.yml --profile migrate run --rm --build migrate
# optional model: start it, pull a model, then set OLLAMA_MODEL in deploy/app.env
OLLAMA_PULL_MODEL=llama3.2:3b docker compose -f deploy/compose.yml --profile model-pull run --rm ollama-pull
docker compose -f deploy/compose.yml --profile model up -d ollama   # stop it first before pulling another model
```

**Only the webhook path is public (security-check M-A).** Sign-in, review and decisions are on the private UI site, so the internet never reaches `/login`. The stock Caddy image has no per-IP rate limiter. If the UI must ever be reachable from untrusted networks, put one in front of it first (a Caddy build with a rate-limit module, or an upstream gateway). Webhook requests are authenticated by their HMAC signature and size-limited by the app before any database work.

**Images contain only an explicit file list (security-check L-1).** The Dockerfile copies `package*.json`, `tsconfig.json`, `next.config.ts`, `src`, `scripts` and `migrations`, never the whole checkout. `.dockerignore` also excludes secret patterns at any depth (`**/*.pem` and so on; a bare `*.pem` matches only the top level there). Build the migrate image with `run --build`: `up --build` does not rebuild services behind a profile, so an old image would otherwise run.

**`APP_ORIGIN` is required behind a TLS proxy.** Set it to the reviewer UI's origin (`https://localhost:8444` in the reference). The app sees `http://` while browsers send `Origin: https://…`. Without `APP_ORIGIN`, every decision and create-PR request is refused with `FORBIDDEN_ORIGIN`. This was found in this verification and fixed by the setting. Set it to the public origin only (scheme, host, port).

**Verified locally (2026-10-12):**
- `up --build` reports every service healthy.
- The migration job applied 0001–0006, and `db:check-grants` reported OK.
- Only the proxy publishes ports.
- **Public site (re-verified after the security check):** `/login`, `/api/health`, `/api/reviews/…` and `/` give 404 from the proxy. An unsigned webhook POST reaches the app, which answers 503 `NOT_CONFIGURED` because no webhook secret is set in the test.
- **Planted dummy secrets** (`deploy/*.pem`, `src/lib/*.pem`, `scripts/*.pw`, a nested `*.dump`, `.npmrc`) were in the checkout while both images were rebuilt. None appeared in the build-stage (migrate) or runtime (app) image. `/app` held only the listed files, and a positive control found `src/lib/security-headers.ts` where expected.
- An earlier check of the build-stage image had run against a stale image, because `up --build` skips profile services. That is why the docs now use `run --build` for the migrate job.
- `/api/health` returns 200 through the private UI site, with HSTS and `X-Frame-Options: DENY`.
- Postgres has no route out.
- **App role password:** the local default `change-me-app-local-only` is refused over the network (`28P01`), and the configured password connects.
- **Session and same-origin:** a session cookie authenticates through the proxy and reaches the database. A same-origin `PATCH` passes the origin check, and a cross-site one gets 403.
- **Browser sign-in through the private UI site (Playwright, a Server Action):** it succeeds with a `__Host-docusync_session` cookie (Secure, HttpOnly, SameSite=Strict). It also succeeds when the browser sends a spoofed `X-Forwarded-Host: evil.example`, so Caddy replaced the header before it reached Next.js; had it passed through, Next would have refused the action as cross-origin.
- **Not verified:**
  - the `ollama` service (its image was not pulled);
  - a real certificate or a public host;
  - GitHub webhooks reaching the proxy.

**First-start init** (both scripts run only when the data volume is first created):
- **`deploy/initdb/01-app-role.sql`:** the deployment's own copy; dev and CI keep `db/init/01-app-role.sql`. It creates `docusync_app` **without login** and no test database.
- **`deploy/initdb/02-app-password.sh`:**
  - refuses an unset, `REPLACE_…` or shorter-than-16-character `POSTGRES_PASSWORD` or `APP_DB_PASSWORD`;
  - otherwise gives the app role `LOGIN` with its password.
  - The password is read inside `psql` from the environment (`\getenv`), not passed as an argument, and the session doesn't log statements on error.
- **Fails closed (security-check L-3, L-5):** if 02 fails, Postgres restarts and skips init, so the app role still can't log in.
  - **Verified with the unedited `*.env.example` files:** init refused with the message, and after the restart the app role was refused with both the committed placeholder and the `REPLACE_…` value.
  - **Residual:** the owner keeps whatever `POSTGRES_PASSWORD` the failed volume was created with. It is reachable only on the internal network. Fix `deploy/postgres.env` and recreate the volume (`docker compose -f deploy/compose.yml down -v`), as the error message says.
- **History:** a bug in the first version of 02 was found and fixed in this verification. `psql -c` doesn't substitute variables, so it left the placeholder password in place.
- **The owner role:** `POSTGRES_USER`, the bootstrap superuser (see "Known limitations" below).
- **Passwords in URLs:** percent-encode any URL-reserved characters in `APP_DB_PASSWORD` and the owner password when you put them into `DATABASE_URL` and `MIGRATION_DATABASE_URL`, or generate URL-safe passwords (for example base64url).
- **The executable bit:** the init script works whether the entrypoint executes it or, without its executable bit, sources it: its body runs in a subshell (fixed after `/review` L5). Commit it executable anyway (`git add --chmod=+x deploy/initdb/02-app-password.sh`).

## Backup and restore (verified 2026-10-12)

```bash
# Backup (custom format), as the owner:
# Write it OUTSIDE the repository: it holds password and session hashes and document content.
pg_dump -U docusync -d docusync -Fc -f /secure/backups/docusync-$(date +%F).dump

# Restore into a new server whose roles already exist (01-app-role.sql ran):
psql -U docusync -d docusync -c "ALTER DEFAULT PRIVILEGES FOR ROLE docusync IN SCHEMA public REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM docusync_app"
pg_restore -U docusync -d docusync --exit-on-error /secure/backups/docusync-<date>.dump
psql -U docusync -d docusync -c "ALTER DEFAULT PRIVILEGES FOR ROLE docusync IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docusync_app"
# Database-level limits are not in the dump (pg_dump without --create); 0002 is not re-run.
psql -U docusync -d docusync -c "REVOKE TEMPORARY ON DATABASE docusync FROM PUBLIC, docusync_app"
npm run db:check-grants      # with MIGRATION_DATABASE_URL pointing at the restored database
```

**Why the default-privilege step matters:**
- `pg_restore` recreates every table as the owner, and the target database's default privileges immediately grant the app role `SELECT, INSERT, UPDATE, DELETE` on it.
- The dump then re-grants only what was recorded and never removes those extras.
- A plain restore therefore silently gives the app role back `UPDATE`/`DELETE` on tables migrations 0002–0005 had restricted.
- Observed on a test restore: the ACL on `repositories` went from `docusync_app=ard` to `arwd`, and the app role could update `github_repo_id`.
- Suspending the default privileges during the restore keeps the table ACLs exactly as dumped.
- `pg_dump` without `--create` does not carry database-level privileges either, so 0002's `REVOKE TEMPORARY` is lost on a new server; the restore re-applies it.
- Dumps are git-ignored and docker-ignored (`*.dump`, `*.backup`, `*.sql.gz`), but keep them outside the repository anyway.
- `npm run db:check-grants` exits non-zero if any app-role limit is missing (and if the app lost a privilege it needs). It checks:
  - whole-table privileges;
  - every column of the column-restricted tables, read from the database itself;
  - TRUNCATE on every table;
  - TEMPORARY on the database and CREATE on schema public.
  Run it after every restore and migration.

**Verified:**
- fresh setup from the README on a new volume: migrations, `reviewer:add`, `analysis:run`, `reviewer:grant`;
- `pg_dump`, then a restore into a second server using the steps above;
- the same row counts (6 migrations, 1 analysis, 1 reviewer, 1 grant) and identical ACLs;
- `db:check-grants` OK, and the app role refused on `repositories` after the restore.
- Re-verified after `/review` M1: straight after the restore, `db:check-grants` failed with "app role has TEMPORARY on the database". After the `REVOKE TEMPORARY` step it reported OK.

## Observability

Record request/analysis IDs, durations, status, retry count, model/provider and safe error codes. Do not log tokens, webhook secrets, full private repository contents or unredacted prompts by default.

## Operational controls

**Kill switches** (each needs a restart):
- **GitHub writes:** `GITHUB_WRITES_ENABLED` not `true`.
- **Model calls:** `OLLAMA_MODEL` empty (deterministic only).
- **Webhook intake:** an empty `GITHUB_ALLOWED_INSTALLATION_IDS` (503).
- **One reviewer:** `npm run reviewer:disable`, which takes effect at once.

**Rate limits (Phase 06):**
- 60 decisions and 10 create-PR requests per reviewer per minute (`429 RATE_LIMITED`).
- Per process, in memory: with several app instances each keeps its own window.
- Sign-in limits are per username.
- A per-IP limiter is still required before the reviewer UI is exposed beyond a private network. The reference proxy publishes only the webhook path.

**Credential rotation and recovery:**
- **GitHub write incidents:** docs/13 "Incident response".
- **Database passwords:** rotate with `ALTER ROLE … PASSWORD` and update `deploy/*.env`.
- **Restores:** the backup and restore procedure above.

## Known limitations of the reference deployment

Fixed after the Phase 06 security check (verified with Docker, 2026-10-15):
- **Ollama isolation:** Ollama sits alone with the app on an internal `model` network. Postgres and the migrate job can no longer reach it. It still has no authentication of its own, so only the app may join that network. Checked in the resolved compose config; the Ollama container itself was not started here.
- **Digest pinning:** the compose images (`caddy`, `postgres`, `ollama`), both Dockerfile stages (`node:24-slim`) and the CI Postgres service are pinned by `@sha256:` digest. The two GitHub Actions are pinned by commit SHA. All digests resolved on 2026-10-15; the tags are kept next to them. Update them deliberately (for example with Dependabot); the pinned images won't pick up security patches by themselves.
- **Container hardening:** the proxy and app run with a read-only root filesystem, `cap_drop: ALL` and `no-new-privileges` (the proxy keeps only `NET_BIND_SERVICE`; scratch space is tmpfs). Verified in the running containers: writes to `/` fail, `/tmp` works for the app, and sign-in through the proxy still works. Postgres and Ollama are not hardened this way, because they write to their data directories and run their own entrypoints.
- **App role attributes:** `db:check-grants` also reports a superuser, `CREATEDB`, `CREATEROLE`, replication or `BYPASSRLS` app role, and any role membership (tested).

Documented, not fixed (security check, Phase 06):
- **Superuser for privileged operations (L-4):** migrations, `db:check-grants`, the `reviewer:*` commands and restores run as `POSTGRES_USER`, the bootstrap superuser.
  - A separate non-superuser schema owner is not set up. That is a permission-model change needing a decision.
  - The app does not assert at startup that `DATABASE_URL` connects as `docusync_app`. Never give the app the owner URL. `db:check-grants` checks the role by name, so it would not notice; it now does check that role's attributes.
- **Postgres and Ollama containers** are not read-only or capability-dropped (see above).
