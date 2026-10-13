"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SideBySideDiff } from "./side-by-side-diff";
import { Notice, linkClass } from "./ui";
import { VisibleText } from "./visible-text";

const PR_URL =
  /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+$/;

export interface CreatePrProps {
  proposalId: string;
  repository: { owner: string; name: string };
  prNumber: number;
  headRef: string;
  headSha: string;
  targetPath: string;
  baseBlobSha: string;
  baseContent: string;
  approvedPatch: string;
  patchSha256: string;
  /** The last failed attempt's code, if any. */
  lastError: string | null;
}

const button =
  "rounded px-3 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

// Set just before the page refreshes after a PR was created: the refreshed page
// replaces this panel, so its PR notice takes focus instead (/review L7).
let focusResultAfterRefresh = false;
const primary = `${button} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`;
const secondary = `${button} border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800`;

/** A link to the documentation PR; anything but a github.com PR URL is not linked. */
export function PullRequestLink({
  url,
  number,
}: {
  url: string;
  number: number;
}) {
  return PR_URL.test(url) ? (
    <a
      href={url}
      className={linkClass}
      rel="noopener noreferrer"
      target="_blank"
    >
      Documentation pull request #{number} on GitHub
    </a>
  ) : (
    <span>Documentation pull request #{number}</span>
  );
}

/** The server-rendered PR notice; takes focus when it replaces the panel. */
export function PrResultNotice({
  url,
  number,
}: {
  url: string;
  number: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusResultAfterRefresh) {
      focusResultAfterRefresh = false;
      ref.current?.focus();
    }
  }, []);
  return (
    <div ref={ref} tabIndex={-1} className="outline-none">
      <Notice tone="success" title="Documentation pull request">
        <PullRequestLink url={url} number={number} />. Review it on GitHub; it
        is never merged automatically.
      </Notice>
    </div>
  );
}

/**
 * The explicit, separate step that writes to GitHub (docs/13). The confirmation
 * shows exactly what was approved; the request echoes the head commit and patch
 * hash, and the server checks everything again before writing.
 */
export function CreatePrPanel(p: CreatePrProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(
    p.lastError
      ? { code: p.lastError, message: "The last attempt failed." }
      : null,
  );
  const [opened, setOpened] = useState<{ url: string; number: number } | null>(
    null,
  );
  const confirmButton = useRef<HTMLButtonElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (wasConfirming.current) openButton.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (opened) result.current?.focus();
  }, [opened]);

  async function create() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(`/api/reviews/${p.proposalId}/create-pr`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          headSha: p.headSha,
          patchSha256: p.patchSha256,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        pullRequest?: { url?: unknown; number?: unknown };
        error?: { code?: string; message?: string };
      } | null;
      const pr = json?.pullRequest;
      if (
        res.ok &&
        typeof pr?.url === "string" &&
        typeof pr.number === "number"
      ) {
        setOpened({ url: pr.url, number: pr.number });
        setConfirming(false);
        focusResultAfterRefresh = true;
        router.refresh();
        return;
      }
      setError({
        code: json?.error?.code ?? "UNKNOWN",
        message: json?.error?.message ?? "The pull request was not created.",
      });
    } catch {
      setError({
        code: "NETWORK_ERROR",
        message:
          "Network error: the result is unknown. Reload the page before trying again.",
      });
    } finally {
      setPending(false);
    }
  }

  if (opened) {
    return (
      <div ref={result} tabIndex={-1} className="outline-none">
        <Notice tone="success" title="Documentation pull request created">
          <PullRequestLink url={opened.url} number={opened.number} />. It is
          never merged automatically.
        </Notice>
      </div>
    );
  }

  return (
    <section
      aria-labelledby="create-pr-heading"
      className="space-y-3 rounded border border-neutral-300 p-4 dark:border-neutral-700"
      onKeyDown={(e) => {
        if (e.key === "Escape" && confirming && !pending) setConfirming(false);
      }}
    >
      <h2 id="create-pr-heading" className="text-lg font-semibold">
        Documentation pull request
      </h2>
      {error && (
        <Notice tone="error" title={error.message}>
          <span className="font-mono text-xs">{error.code}</span>
        </Notice>
      )}
      {!confirming ? (
        <>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            Opens one pull request with this approved change, on a new branch
            based on the source pull request&apos;s head. It is never merged
            automatically.
          </p>
          <button
            ref={openButton}
            type="button"
            className={primary}
            onClick={() => setConfirming(true)}
          >
            Create documentation PR…
          </button>
        </>
      ) : (
        <div className="space-y-3" aria-busy={pending}>
          <p className="text-sm font-medium">
            Confirm what will be written to GitHub:
          </p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt>Repository</dt>
            <dd className="font-mono">
              <VisibleText
                text={`${p.repository.owner}/${p.repository.name}`}
              />
            </dd>
            <dt>Source pull request</dt>
            <dd>
              #{p.prNumber}, head branch{" "}
              <span className="font-mono">
                <VisibleText text={p.headRef} />
              </span>{" "}
              (the new pull request&apos;s base)
            </dd>
            <dt>Head commit</dt>
            <dd className="font-mono break-all">{p.headSha}</dd>
            <dt>File</dt>
            <dd className="font-mono">
              <VisibleText text={p.targetPath} />
            </dd>
            <dt>Document blob</dt>
            <dd className="font-mono break-all">{p.baseBlobSha}</dd>
            <dt>Approved patch SHA-256</dt>
            <dd className="font-mono break-all">{p.patchSha256}</dd>
          </dl>
          <SideBySideDiff
            path={p.targetPath}
            original={p.baseContent}
            patch={p.approvedPatch}
          />
          <div className="flex flex-wrap gap-2">
            <button
              ref={confirmButton}
              type="button"
              className={primary}
              // aria-disabled, not disabled: a disabled button drops focus to
              // the page body while the request runs (/review L7).
              aria-disabled={pending}
              onClick={() => {
                if (!pending) void create();
              }}
            >
              {pending ? "Creating…" : "Create pull request"}
            </button>
            <button
              type="button"
              className={secondary}
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
