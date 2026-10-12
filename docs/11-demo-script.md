# Demo Script

Use a repository you own and synthetic/sample content. Never use private code without permission.

## Scenario

A pull request changes an environment variable or API route. The tool should flag a relevant README/API/deployment document, show evidence, propose a narrow patch, allow a reviewer to edit or reject it, then create a separate documentation PR only after approval.

## Demo sequence

1. Show the sample repository and baseline docs.
2. Open a pull request containing a small behavior/configuration change.
3. Show the analysis status and changed-file summary.
4. Open the impact list and inspect evidence for each candidate.
5. Inspect the generated patch and its validation result.
6. Reject one proposal and confirm it is not included.
7. Edit or accept another proposal.
8. Explicitly approve creation of the documentation PR.
9. Show the separate PR, CI checks and audit/review record.
10. Demonstrate a negative case: a refactor that should not trigger an unnecessary doc edit, or a prompt-injection fixture that is treated as untrusted data.

## Demo quality bar

- No fake successful states.
- No exposed credentials.
- No unreviewed write operation.
- Have a reproducible fallback recording or fixture-driven demo if external GitHub/Ollama services are unavailable.
- State clearly which parts are live and which are mocked.

## What can be shown today (Phase 05)

- **Steps 3–7 with fixtures:** `npm run analysis:run -- --fixture <name>`. Fixture analyses never offer a PR; the page says so.
- **Steps 1–9 live:** these need your own GitHub App with the permissions in docs/10, `GITHUB_WRITES_ENABLED=true`, `GITHUB_APP_SLUG`, and a same-repository PR analysed with `npm run analysis:run -- --live owner/repo#N --installation <id>`. Then grant a reviewer, accept or edit, and press **Create documentation PR…**.
- **Not run in this repository:** the live path and the GitHub write have only been exercised against a fetch-level fake of GitHub (`src/test/fake-github.ts`). The first live run must be treated as unverified, and step 9's CI checks depend on the target repository.
