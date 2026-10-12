import Link from "next/link";
import { linkClass } from "@/components/ui";

export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto w-full max-w-6xl flex-1 space-y-3 px-4 py-8"
    >
      <h1 className="text-2xl font-semibold">Not found</h1>
      <p>
        This page doesn&apos;t exist, or you don&apos;t have access to the
        repository it belongs to.
      </p>
      <Link href="/" className={linkClass}>
        Back to your reviews
      </Link>
    </main>
  );
}
