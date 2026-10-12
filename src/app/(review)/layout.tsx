import { Suspense } from "react";
import { SiteHeader } from "@/components/site-header";
import { SessionNav } from "./session-nav";

// Signed-in pages only. The login page sits outside this group, so it never reads
// the session: re-rendering it after a failed no-JavaScript sign-in while calling
// cookies() trips a Next.js invariant.
export default function ReviewLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader>
        <Suspense fallback={null}>
          <SessionNav />
        </Suspense>
      </SiteHeader>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {children}
      </main>
    </>
  );
}
