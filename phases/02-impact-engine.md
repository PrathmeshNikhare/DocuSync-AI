# Phase 02 — Evidence-Backed Impact Engine

## Goal

Identify likely affected documentation using deterministic signals and explicit evidence.

## Tasks

- Build diff parsing and changed-file classification.
- Extract references to routes, exports, configuration keys, environment variables, scripts and doc paths where feasible.
- Find candidate docs through repository conventions and explicit links.
- Create transparent, configurable ranking rules.
- Return `likely_affected`, `verify` or `unlikely_affected` with evidence references.
- Add fixture scenarios including changes with no documentation impact.
- Create an initial labelled evaluation dataset and record its limits.
- Keep the engine independent of Next.js and model provider code.

## Exit criteria

- Candidate results satisfy shared schemas.
- Evidence points to actual fixture source and is bounded.
- False-positive/false-negative cases are represented in tests.
- Deterministic baseline metrics are calculated from labelled fixtures.
- No uncalibrated score is presented as probability.
- Docs/status/handoff updated.
