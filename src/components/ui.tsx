import type { ReactNode } from "react";

// Small shared pieces for the review UI. Status is always spelled out in text,
// never shown by colour alone.

export function LoadingState({ label }: { label: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className="py-8 text-sm text-neutral-600 dark:text-neutral-400"
    >
      {label}…
    </p>
  );
}

export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <section className="rounded border border-dashed border-neutral-300 p-6 dark:border-neutral-700">
      <h2 className="font-medium">{title}</h2>
      {children && (
        <div className="mt-2 text-sm text-neutral-700 dark:text-neutral-300">
          {children}
        </div>
      )}
    </section>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: "info" | "warning" | "error" | "success";
  title: string;
  children?: ReactNode;
}) {
  const tones = {
    info: "border-sky-300 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100",
    warning:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100",
    error:
      "border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
    success:
      "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100",
  } as const;
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded border px-4 py-3 text-sm ${tones[tone]}`}
    >
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

const IMPACT_LABEL = {
  likely_affected: "Likely affected",
  verify: "Verify",
  unlikely_affected: "Unlikely affected",
} as const;

export function ImpactBadge({ status }: { status: keyof typeof IMPACT_LABEL }) {
  const tone =
    status === "likely_affected"
      ? "bg-red-100 text-red-900 dark:bg-red-900 dark:text-red-100"
      : status === "verify"
        ? "bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100"
        : "bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200";
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${tone}`}>
      {IMPACT_LABEL[status]}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded border border-neutral-300 px-1.5 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:text-neutral-300">
      {children}
    </span>
  );
}

export const shortSha = (sha: string) => sha.slice(0, 12);

/** Fixed UTC format, so server and browser render the same text. */
export const formatTime = (iso: string) =>
  `${iso.slice(0, 16).replace("T", " ")} UTC`;

export const linkClass =
  "text-sky-800 underline underline-offset-2 hover:text-sky-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:text-sky-300 dark:hover:text-sky-100";
