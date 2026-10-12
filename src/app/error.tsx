"use client";

/** Unexpected failures: no details are shown, only a way to retry. */
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main
      id="main"
      role="alert"
      className="mx-auto w-full max-w-6xl flex-1 space-y-3 px-4 py-8"
    >
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p>The page couldn&apos;t be loaded. Nothing was changed.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Try again
      </button>
    </main>
  );
}
