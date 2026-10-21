# Review UI and UX

The review UI is where a person decides what happens to a proposal. The primary path should be understandable without reading project documentation: inspect evidence → inspect patch → edit, accept or reject → understand what happens next. Real captures of this flow are in `docs/assets/screenshots/` (see docs/11).

## Principles

- Show loading, empty, success, partial-result and error states.
- Distinguish deterministic evidence from model-generated explanation. Model text is labelled as model-written and unverified.
- Show why a document was selected and which source change supports the claim.
- Make uncertainty visible and imply no false precision: rule points are titled "not a probability".
- Require a confirmation step for decisions and for GitHub write actions, and display the target repository, branch and source SHA before approval.
- Treat keyboard navigation and accessible labels as first-class, and support narrow viewports.
- Use no fake metrics, repositories, activity or nonfunctional controls. Fixture data is always labelled.
- Restrained, readable design: strong hierarchy, dense but scannable information, no decorative charts without real data.

## Screens

| Route | Purpose |
|---|---|
| `/login` | Sign-in with a local reviewer account |
| `/` | Dashboard: the repositories the reviewer can access, and recent analyses |
| `/analyses/[id]` | One analysis: the PR, its changed files and the candidate documents |
| `/reviews/[id]` | One proposal: evidence, diff and the decision |

- **Dashboard:** recent analyses with status, model status, flagged documents and decided proposals. Empty states cover no access (with the operator command) and no analyses, and a notice appears for failures. Fixture data is labelled.
- **Analysis:** the PR, head commit, status and engine; the changed files; and each candidate with its status (spelled out, not colour alone), rule points, reason, deterministic evidence with exact quoted lines, uncertainty, and the model's assessment in a separate, labelled box. Partial, failed and running states are explicit, each candidate says why it has no patch, and a partial analysis shows "Partial analysis: some documentation could not be read" above the missing-context list.
- **Review:** "what this decision applies to" (repository, PR, head commit, document blob), why the document was chosen, the model rationale (labelled), the original and proposed text side by side with unchanged stretches collapsed, and the raw patch.
  - **Before a decision:** accept, edit or reject, each with its consequence spelled out. Accept and reject need a confirm step, and edit opens a labelled patch editor.
  - **After a decision:** a completion state and the audit trail. It says plainly that no GitHub pull request has been created.

## Creating the documentation PR

After an accept or edit on a live analysis, the decision section shows **Create documentation PR…** when writes are enabled.
- It opens an inline confirmation (not a modal dialog) and moves focus to it; Escape cancels. The confirmation shows the repository, source PR and head branch (hidden characters marked), the head commit, file, document blob and approved patch hash, and the approved diff itself.
- Confirming sends the head commit and patch hash back, and the server re-checks everything (docs/13).
- While pending, the confirm button stays focused and uses `aria-disabled`, so a second press does nothing. After a failure, focus stays on it; after success, the refreshed page's PR notice takes focus once.
- Success shows a link to the PR, only if it is a github.com pull request URL, opened with `noopener noreferrer`. Failures show the server's message and code. A created PR is shown as a link on every later visit.
- Fixture data, disabled writes and analyses without branch names each get an explanation instead of the button.

## Accessibility and layout

- A skip link and landmarks; headings in order; tables with captions and scoped headers.
- Labelled inputs with autocomplete hints, and visible focus rings.
- Focus moves into each decision step, with Escape to cancel; alerts and status messages are announced.
- Removed and added diff lines are named for screen readers.
- The layout works at narrow widths, with wide tables scrolling sideways. Light and dark follow the system setting. There are no animations, so reduced-motion preferences are respected by default.
- **Not tested:** a real browser's keyboard flow beyond the component tests, screen-reader output and the narrow-viewport layout (docs/08).
