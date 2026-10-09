# UI/UX Requirements

## Main screens

1. Dashboard: repositories, recent analyses, status and failures.
2. Analysis detail: changed files, affected documentation candidates, evidence and uncertainty.
3. Review detail: original Markdown and proposed diff side by side.
4. Review controls: accept, edit, reject, with clear consequences.
5. Completion state: generated documentation PR URL and validation status.

## Interaction requirements

- Always show loading, empty, success, partial-result and error states.
- Clearly distinguish deterministic evidence from model-generated explanation.
- Show why a document was selected and which source change supports the claim.
- Make uncertainty visible; do not imply false precision.
- Require confirmation for GitHub write actions.
- Display target repository, branch and source SHA before approval.
- Make keyboard navigation and accessible labels first-class.
- Support narrow viewports and reduced-motion preferences.
- Do not use fake metrics, fake repositories, fake activity or nonfunctional controls in the final demo.

## Visual direction

Build a polished developer tool: restrained color, readable typography, strong hierarchy, dense but scannable information, consistent spacing and purposeful empty states. Avoid generic AI gradients, excessive cards, emoji-as-icons and decorative charts without real data.

## Acceptance

The primary review path should be understandable without reading project documentation: inspect evidence → inspect patch → edit/accept/reject → understand what happens next.
