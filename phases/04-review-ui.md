# Phase 04 — Human Review UI

## Goal

Build a useful dashboard for reviewing evidence and proposed documentation diffs.

## Tasks

- Implement dashboard and analysis detail pages.
- Display candidate status, reason, evidence and uncertainty.
- Implement a side-by-side diff view.
- Implement accept/edit/reject actions with server-side authorization and validation.
- Persist review decisions and show a clear audit trail.
- Provide loading, empty, error, partial-result and success states.
- Add accessible keyboard interaction and responsive layout.
- Ensure the UI does not perform GitHub writes directly.

## Exit criteria

- Reviewer can inspect evidence and patch.
- Accept/edit/reject persist correctly and invalid transitions fail.
- UI states are tested.
- Authorization checks are server-side.
- No fake live data or nonfunctional controls in the primary flow.
- Docs/status/handoff updated.
