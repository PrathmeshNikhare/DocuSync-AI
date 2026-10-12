"use server";

import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db/pool";
import { logEvent } from "@/lib/log";
import { codeOnlyErrors } from "@/lib/review/safe";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/review/auth";
import { login, revokeSession } from "@/lib/review/session";

export interface LoginState {
  error?: string;
}

const field = (form: FormData, name: string, max: number) => {
  const v = form.get(name);
  return typeof v === "string" ? v.slice(0, max) : "";
};

async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const result = await login(
    getPool(),
    field(form, "username", 64).trim().toLowerCase(),
    field(form, "password", 256),
  );
  // Outcome only: never the username or password (the log fields are closed).
  logEvent("auth_login", {
    requestId: randomUUID(),
    outcome: result.ok ? "ok" : result.code.toLowerCase(),
  });
  if (!result.ok) return { error: LOGIN_ERRORS[result.code] };
  (await cookies()).set(SESSION_COOKIE, result.token, sessionCookieOptions);
  redirect("/");
}

const LOGIN_ERRORS = {
  INVALID_CREDENTIALS: "Incorrect username or password.",
  RATE_LIMITED:
    "Too many failed sign-in attempts. Wait 15 minutes, then try again.",
  BUSY: "Sign-in is busy. Try again in a moment.",
} as const;

async function signOut(): Promise<void> {
  logEvent("auth_logout", { requestId: randomUUID(), outcome: "ok" });
  const jar = await cookies();
  await revokeSession(getPool(), jar.get(SESSION_COOKIE)?.value);
  // Overwrite with the same options: browsers ignore a delete of a `__Host-`
  // cookie that lacks Secure, which is what a bare delete() sends.
  jar.set(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 });
  redirect("/login");
}

/** Server Actions check the request origin, so the login form can't be posted cross-site. */
export async function loginAction(
  prev: LoginState,
  form: FormData,
): Promise<LoginState> {
  return codeOnlyErrors("action_login", () => signIn(prev, form));
}

export async function logoutAction(): Promise<void> {
  return codeOnlyErrors("action_logout", () => signOut());
}
