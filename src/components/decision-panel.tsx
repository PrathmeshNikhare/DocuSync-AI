"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Notice } from "./ui";

type Choice = "accepted" | "rejected";
type Opener = "accepted" | "edit" | "rejected";
type Mode =
  { kind: "idle" } | { kind: "confirm"; decision: Choice } | { kind: "edit" };

const ERROR_TEXT: Record<string, string> = {
  UNAUTHENTICATED:
    "Your session has ended. Sign in again, then repeat your decision.",
  NOT_FOUND: "This proposal is no longer available to you.",
  PROPOSAL_NOT_VALID:
    "This proposal did not pass validation, so it can't be accepted or rejected.",
  INVALID_TRANSITION:
    "This proposal already has a decision. Reload the page to see it.",
  EDIT_UNCHANGED:
    "The edited patch is identical to the proposal. Accept it instead, or change it.",
  EDIT_INVALID:
    "The edited patch did not pass validation, so nothing was recorded:",
  FORBIDDEN_ORIGIN:
    "The request was refused because it did not come from this site.",
  PAYLOAD_TOO_LARGE: "The edited patch is too large.",
};

const CONSEQUENCE: Record<Choice, string> = {
  accepted:
    "Accepting records your approval of this exact patch for this revision. Nothing is written to GitHub: opening the documentation pull request is a separate step, which is not available yet.",
  rejected: "Rejecting records that this patch should not be used.",
};

const button =
  "rounded px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed disabled:opacity-60";
const primary = `${button} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`;
const secondary = `${button} border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800`;

/**
 * Accept, edit or reject one proposal. Decisions are final (D-012), so accept and
 * reject ask for confirmation. The server validates everything again; this panel
 * only reports what it says.
 */
export function DecisionPanel({
  proposalId,
  patch,
}: {
  proposalId: string;
  patch: string;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [edited, setEdited] = useState(patch);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{
    message: string;
    issues?: string[];
  } | null>(null);
  const [recorded, setRecorded] = useState<string | null>(null);
  const focusTarget = useRef<HTMLButtonElement & HTMLTextAreaElement>(null);
  // The button that opened the current step, so focus can return to it.
  const opener = useRef<Opener | null>(null);
  const openers = useRef<Partial<Record<Opener, HTMLButtonElement | null>>>({});
  const success = useRef<HTMLDivElement>(null);

  // Move focus into the step that just opened, and back to its button when it
  // closes, so keyboard and screen-reader users never land on the page body.
  useEffect(() => {
    if (mode.kind !== "idle") {
      focusTarget.current?.focus();
    } else if (opener.current) {
      openers.current[opener.current]?.focus();
      opener.current = null;
    }
  }, [mode]);
  useEffect(() => {
    if (recorded) success.current?.focus();
  }, [recorded]);

  const open = (which: Opener, next: Mode) => {
    opener.current = which;
    setMode(next);
  };

  async function submit(
    body: { decision: Choice } | { decision: "edited"; editedPatch: string },
  ) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviews/${proposalId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string };
        issues?: string[];
      } | null;
      if (!res.ok) {
        const code = json?.error?.code ?? "";
        setError({
          message:
            ERROR_TEXT[code] ??
            json?.error?.message ??
            "The decision was not recorded.",
          issues: json?.issues,
        });
        return;
      }
      setRecorded(body.decision);
      setMode({ kind: "idle" });
      router.refresh();
    } catch {
      setError({
        message: "Network error: the decision was not recorded. Try again.",
      });
    } finally {
      setPending(false);
    }
  }

  if (recorded) {
    return (
      <div ref={success} tabIndex={-1} className="outline-none">
        <Notice tone="success" title={`Decision recorded: ${recorded}`}>
          Loading the updated review…
        </Notice>
      </div>
    );
  }

  const cancel = () => {
    setMode({ kind: "idle" });
    setError(null);
  };

  return (
    <section
      aria-labelledby="decision-heading"
      className="space-y-3 rounded border border-neutral-300 p-4 dark:border-neutral-700"
      onKeyDown={(e) => {
        if (e.key === "Escape" && mode.kind !== "idle" && !pending) cancel();
      }}
    >
      <h2 id="decision-heading" className="text-lg font-semibold">
        Your decision
      </h2>
      <p className="text-sm text-neutral-700 dark:text-neutral-300">
        Decisions are final. Each one is recorded with your name, the time, this
        revision and a hash of the approved patch.
      </p>

      {error && (
        <Notice tone="error" title={error.message}>
          {error.issues && (
            <ul className="list-disc pl-5 font-mono text-xs">
              {error.issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          )}
        </Notice>
      )}

      {mode.kind === "idle" && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={primary}
            ref={(el) => {
              openers.current.accepted = el;
            }}
            onClick={() =>
              open("accepted", { kind: "confirm", decision: "accepted" })
            }
          >
            Accept…
          </button>
          <button
            type="button"
            className={secondary}
            ref={(el) => {
              openers.current.edit = el;
            }}
            onClick={() => open("edit", { kind: "edit" })}
          >
            Edit patch…
          </button>
          <button
            type="button"
            className={secondary}
            ref={(el) => {
              openers.current.rejected = el;
            }}
            onClick={() =>
              open("rejected", { kind: "confirm", decision: "rejected" })
            }
          >
            Reject…
          </button>
        </div>
      )}

      {mode.kind === "confirm" && (
        <div className="space-y-2" aria-busy={pending}>
          <p className="text-sm">{CONSEQUENCE[mode.decision]}</p>
          <div className="flex flex-wrap gap-2">
            <button
              ref={focusTarget}
              type="button"
              className={primary}
              disabled={pending}
              onClick={() => submit({ decision: mode.decision })}
            >
              {pending
                ? "Recording…"
                : mode.decision === "accepted"
                  ? "Confirm accept"
                  : "Confirm reject"}
            </button>
            <button
              type="button"
              className={secondary}
              disabled={pending}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode.kind === "edit" && (
        <form
          className="space-y-2"
          aria-busy={pending}
          onSubmit={(e) => {
            e.preventDefault();
            void submit({ decision: "edited", editedPatch: edited });
          }}
        >
          <label htmlFor="edited-patch" className="block text-sm font-medium">
            Edited patch (unified diff)
          </label>
          <p
            id="edited-patch-help"
            className="text-sm text-neutral-700 dark:text-neutral-300"
          >
            Your edit is checked with the same rules as the model&apos;s patch:
            same file, same revision, narrow changes, no new links or HTML.
            Saving records it as your decision.
          </p>
          <textarea
            id="edited-patch"
            ref={focusTarget}
            aria-describedby="edited-patch-help"
            className="h-72 w-full rounded border border-neutral-300 bg-white p-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-950"
            spellCheck={false}
            value={edited}
            onChange={(e) => setEdited(e.target.value)}
            disabled={pending}
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={primary} disabled={pending}>
              {pending ? "Recording…" : "Save edited patch"}
            </button>
            <button
              type="button"
              className={secondary}
              disabled={pending}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
