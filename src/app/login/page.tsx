import type { Metadata } from "next";
import { loginAction } from "@/app/actions";
import { LoginForm } from "@/components/login-form";
import { SiteHeader } from "@/components/site-header";

export const metadata: Metadata = { title: "Sign in · DocuSync AI" };

export default function LoginPage() {
  return (
    <>
      <SiteHeader />
      <main
        id="main"
        className="mx-auto w-full max-w-sm flex-1 space-y-6 px-4 py-12"
      >
        <h1 className="text-2xl font-semibold">Sign in to review</h1>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Reviewer accounts are created by an operator. There is no self
          sign-up.
        </p>
        <LoginForm action={loginAction} />
      </main>
    </>
  );
}
