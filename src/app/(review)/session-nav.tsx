import { logoutAction } from "@/app/actions";
import { getCurrentReviewer } from "@/lib/review/auth";

/** Reads the session, so it sits behind a Suspense boundary in the layout. */
export async function SessionNav() {
  const reviewer = await getCurrentReviewer();
  if (!reviewer) return null;
  return (
    <form action={logoutAction} className="flex items-center gap-3 text-sm">
      <span className="text-neutral-700 dark:text-neutral-300">
        Signed in as <span className="font-medium">{reviewer.displayName}</span>
      </span>
      <button
        type="submit"
        className="rounded border border-neutral-300 px-2 py-1 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:border-neutral-700 dark:hover:bg-neutral-800"
      >
        Sign out
      </button>
    </form>
  );
}
