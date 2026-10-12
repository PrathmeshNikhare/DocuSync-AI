import Link from "next/link";
import type { ReactNode } from "react";

export function SiteHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link
          href="/"
          className="font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        >
          DocuSync AI
        </Link>
        {children}
      </div>
    </header>
  );
}
