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

## Implemented (Phase 04)

- **Dashboard (`/`):** the repositories the reviewer can access, and recent analyses with status, model status, flagged documents and decided proposals. It has empty states for no access (with the operator command) and for no analyses, and a notice for failures. Fixture data is labelled.
- **Analysis (`/analyses/[id]`):** the PR, head commit, status and engine; the changed files; and each candidate with its status (spelled out, not colour alone), rule points (titled "not a probability"), reason, deterministic evidence with exact quoted lines, uncertainty, and the model's assessment in a separate, labelled box. Partial, failed and running states are explicit, and each candidate says why it has no patch.
- **Review (`/reviews/[id]`):** "what this decision applies to" (repository, PR, head commit, document blob), why the document was chosen, the model rationale (labelled), the original and proposed text side by side with unchanged stretches collapsed, and the raw patch.
  - **Before a decision:** accept, edit or reject, each with its consequence spelled out. Accept and reject need a confirm step, and the edit opens a labelled patch editor.
  - **After a decision:** a completion state and the audit trail. It says plainly that no GitHub pull request has been created.
- **Accessibility:**
  - a skip link and landmarks;
  - headings in order;
  - tables with captions and scoped headers;
  - labelled inputs with autocomplete hints;
  - visible focus rings;
  - focus moved into each decision step, with Escape to cancel;
  - alerts and status messages announced;
  - removed and added diff lines named for screen readers.
- **Layout:** works at narrow widths, with wide tables scrolling sideways. Light and dark follow the system setting. There are no animations, so reduced-motion preferences are respected by default.
- **Not yet:** the completion state shows no PR URL, because there is no GitHub write yet (Phase 05).
