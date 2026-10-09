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
