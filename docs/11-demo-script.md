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

## What could be shown at the end of Phase 05

- **Steps 3–7 with fixtures:** `npm run analysis:run -- --fixture <name>`. Fixture analyses never offer a PR; the page says so.
- **Steps 1–9 live:** these need your own GitHub App with the permissions in docs/10, `GITHUB_WRITES_ENABLED=true`, `GITHUB_APP_SLUG`, and a same-repository PR analysed with `npm run analysis:run -- --live owner/repo#N --installation <id>`. Then grant a reviewer, accept or edit, and press **Create documentation PR…**.
- **Not run in this repository:** the live path and the GitHub write have only been exercised against a fetch-level fake of GitHub (`src/test/fake-github.ts`). The first live run must be treated as unverified, and step 9's CI checks depend on the target repository.

## Recorded walkthrough (Phase 06)

Captured on 2026-10-13 with `npm run screenshots` (re-captured after the screenshot script was hardened). Playwright drives the real UI of a local production build (`next start`), signed in as a reviewer created for the capture. The analysis is a real pipeline run over the labelled fixture `env-var-renamed`, with `llama3.2:3b` writing the assessment and patch. Nothing was edited after capture.

| Step | Screenshot | Live or mocked |
|---|---|---|
| 1. Sign in | `docs/screenshots/01-login.png` | live (local reviewer account) |
| 2. Dashboard | `docs/screenshots/02-dashboard.png` | live; data is fixture-labelled |
| 3. Analysis: evidence, uncertainty, model assessment | `docs/screenshots/03-analysis.png` | live engine and model on a fixture PR |
| 4. Review: side-by-side patch, validation statement | `docs/screenshots/04-review.png` | live |
| 5. Accept confirmation ("Nothing is written to GitHub") | `docs/screenshots/05-accept-confirm.png` | live |
| 6. Recorded decision, audit trail, "No pull request for fixture data" | `docs/screenshots/06-decided.png` | live |
| 7. Create documentation PR | not captured | **mocked only.** No GitHub App is set up, so the write path runs only against the fake GitHub in tests. Fixture data never offers the button |

**About the patch in steps 4–6:** the model's patch renames the variable correctly, but it also adds "(deprecated)" to the new `API_KEY` row, which is wrong. Validation passed: the patch is narrow, related, and has no links or HTML. As the page says, validation "does not check that the text is correct". In the capture the reviewer accepted it anyway. In a real review this is exactly what **Edit patch…** or **Reject…** are for. It shows why human approval is the control, not the validator.

**Safeguards in the script:** the capture approves a proposal as the signed-in reviewer. So the script:
- refuses any review that isn't labelled "Fixture data, not a live repository";
- requires https unless the app is local;
- prints only fixed error codes;
- writes the screenshots only when the whole run succeeds.

**To reproduce:**

```bash
npm run build && npm start                    # with .env.local; any port
npm run reviewer:add -- --username demo --name "Demo Reviewer" --password-file ./demo.pw
OLLAMA_MODEL=llama3.2:3b npm run analysis:run -- --fixture env-var-renamed   # note the analysis id
npm run reviewer:grant -- --username demo --repo fixture/env-var-renamed
SCREENSHOT_BASE_URL=http://localhost:3000 SCREENSHOT_USERNAME=demo \
  SCREENSHOT_PASSWORD_FILE=./demo.pw SCREENSHOT_ANALYSIS_ID=<id> npm run screenshots
```

The capture accepts the proposal it reviews. Use a fresh analysis each time.

**Negative case:**
- The `injection-in-doc` fixture is treated as data in both evaluations.
- The model's injected-HTML patch is rejected by validation (`PATCH_UNSAFE_HTML`, docs/evaluation/llm-assisted.md).
