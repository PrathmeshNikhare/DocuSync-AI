import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: async () => jar }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  // Like Next's: its own control-flow errors pass through codeOnlyErrors.
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith("REDIRECT")) throw err;
  },
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({}) }));
const login = vi.fn();
const revokeSession = vi.fn();
vi.mock("@/lib/review/session", async (orig) => ({
  ...(await orig<typeof import("@/lib/review/session")>()),
  login: (...a: unknown[]) => login(...a),
  revokeSession: (...a: unknown[]) => revokeSession(...a),
}));

const { loginAction, logoutAction } = await import("./actions");
const { SESSION_COOKIE } = await import("@/lib/review/auth");

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

const form = (username: string, password: string) => {
  const f = new FormData();
  f.set("username", username);
  f.set("password", password);
  return f;
};

describe("loginAction", () => {
  it("sets an HttpOnly, SameSite=Strict, 12-hour session cookie and redirects", async () => {
    login.mockResolvedValue({ ok: true, token: "t".repeat(43), reviewer: {} });
    await expect(loginAction({}, form("Alice ", "pw"))).rejects.toThrow(
      "REDIRECT /",
    );
    expect(login).toHaveBeenCalledWith({}, "alice", "pw");
    expect(jar.set).toHaveBeenCalledWith(SESSION_COOKIE, "t".repeat(43), {
      httpOnly: true,
      sameSite: "strict",
      secure: false, // tests run with NODE_ENV=test; production sets Secure and __Host-
      path: "/",
      maxAge: 12 * 60 * 60,
    });
  });

  it("returns a message and sets no cookie when sign-in fails or is rate limited", async () => {
    login.mockResolvedValue({ ok: false, code: "INVALID_CREDENTIALS" });
    expect(await loginAction({}, form("alice", "x"))).toEqual({
      error: "Incorrect username or password.",
    });
    login.mockResolvedValue({ ok: false, code: "RATE_LIMITED" });
    expect((await loginAction({}, form("alice", "x"))).error).toMatch(
      /Too many failed/,
    );
    expect(jar.set).not.toHaveBeenCalled();
  });
});

describe("auth log events", () => {
  it("record the outcome of every sign-in and sign-out, never the username or password", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    login.mockResolvedValue({ ok: false, code: "RATE_LIMITED" });
    await loginAction({}, form("alice", "hunter2-secret"));
    login.mockResolvedValue({ ok: false, code: "BUSY" });
    expect(
      (await loginAction({}, form("alice", "hunter2-secret"))).error,
    ).toMatch(/busy/);
    jar.get.mockReturnValue(undefined);
    await expect(logoutAction()).rejects.toThrow("REDIRECT /login");
    const lines = logs.mock.calls.map(
      (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
    );
    expect(lines.map((l) => [l.name, l.outcome])).toEqual([
      ["auth_login", "rate_limited"],
      ["auth_login", "busy"],
      ["auth_logout", "ok"],
    ]);
    expect(lines.every((l) => typeof l.requestId === "string")).toBe(true);
    expect(JSON.stringify(lines)).not.toMatch(/alice|hunter2/);
    logs.mockRestore();
  });
});

describe("unexpected errors", () => {
  it("are logged as a code only and replaced by a generic error", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    login.mockRejectedValue(
      new Error("connect ECONNREFUSED db.internal user=docusync_app"),
    );
    await expect(loginAction({}, form("alice", "pw"))).rejects.toThrow(
      /^INTERNAL_ERROR$/,
    );
    const line = logs.mock.calls.map((c) => String(c[0])).join("\n");
    expect(line).toContain('"name":"action_login"');
    expect(line).toContain('"code":"INTERNAL_ERROR"');
    expect(line).not.toContain("ECONNREFUSED");
    logs.mockRestore();
  });
});

describe("logoutAction", () => {
  it("revokes the session and overwrites the cookie with the same options", async () => {
    jar.get.mockReturnValue({ value: "t".repeat(43) });
    await expect(logoutAction()).rejects.toThrow("REDIRECT /login");
    expect(revokeSession).toHaveBeenCalledWith({}, "t".repeat(43));
    // A bare delete() would drop Secure, which browsers need to clear a __Host- cookie.
    expect(jar.set).toHaveBeenCalledWith(
      SESSION_COOKIE,
      "",
      expect.objectContaining({
        httpOnly: true,
        sameSite: "strict",
        path: "/",
        maxAge: 0,
      }),
    );
    expect(jar.delete).not.toHaveBeenCalled();
  });
});
