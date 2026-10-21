# Documentation Index

Start with the [README](../README.md) for what DocuSync AI is and how it works at a glance.

## Run and develop

| Document | Purpose |
|---|---|
| [`setup.md`](setup.md) | Local setup, the fixture and model walkthroughs, test webhook |
| [`development.md`](development.md) | Stack, commands, verification, conventions |
| [`10-deployment-and-operations.md`](10-deployment-and-operations.md) | GitHub App setup, reviewer accounts, the reference Docker deployment, backup and restore, operations |
| [`11-demo-script.md`](11-demo-script.md) | Reproducible demonstration and the recorded screenshot walkthrough |

## Design

| Document | Purpose |
|---|---|
| [`01-requirements.md`](01-requirements.md) | Product scope, users and requirements |
| [`02-architecture.md`](02-architecture.md) | System boundaries, data flow and trust boundaries |
| [`03-data-model.md`](03-data-model.md) | Persistence entities, invariants and migrations |
| [`04-api-contracts.md`](04-api-contracts.md) | HTTP and webhook contracts |
| [`05-impact-engine.md`](05-impact-engine.md) | Candidate selection and the evidence model |
| [`06-llm-and-patches.md`](06-llm-and-patches.md) | Ollama provider, prompting and patch validation |
| [`09-ui-ux.md`](09-ui-ux.md) | Review workflow and design principles |
| [`13-github-write-workflow.md`](13-github-write-workflow.md) | The approval-gated GitHub write design |
| [`decisions.md`](decisions.md) | Engineering decisions D-001 to D-016 |

## Security, testing and evaluation

| Document | Purpose |
|---|---|
| [`07-security.md`](07-security.md) | Threat model, controls and the tests that evidence them |
| [`08-testing-and-evaluation.md`](08-testing-and-evaluation.md) | Test strategy, evaluation protocol and results |
| [`evaluation/`](evaluation/) | Generated reports: `impact-baseline.md` (deterministic, checked by a test), `impact-latency.md`, `llm-assisted.md`. Do not edit by hand. |

## Assets

[`assets/screenshots/`](assets/screenshots/) holds real UI captures taken with `npm run screenshots` from fixture data (see `11-demo-script.md`).

The numbered file names are stable: source comments, scripts and deployment files refer to them as `docs/NN`.
