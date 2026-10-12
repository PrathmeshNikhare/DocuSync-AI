"use client";

import { useActionState } from "react";
import type { LoginState } from "@/app/actions";

export function LoginForm({
  action,
}: {
  action: (state: LoginState, form: FormData) => Promise<LoginState>;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-4" aria-busy={pending}>
      {state.error && (
        <p
          role="alert"
          className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-800 dark:bg-red-950 dark:text-red-100"
        >
          {state.error}
        </p>
      )}
      <div className="space-y-1">
        <label htmlFor="username" className="block text-sm font-medium">
          Username
        </label>
        <input
          id="username"
          name="username"
          autoComplete="username"
          required
          maxLength={39}
          autoCapitalize="none"
          spellCheck={false}
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>
      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={200}
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
