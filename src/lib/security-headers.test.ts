import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./security-headers";
import nextConfig from "../../next.config";

describe("security headers", () => {
  it("send HSTS in production only", () => {
    const hsts = (env: "development" | "production" | "test") =>
      securityHeaders(env).find((h) => h.key === "Strict-Transport-Security");
    expect(hsts("production")?.value).toBe("max-age=31536000");
    expect(hsts("development")).toBeUndefined();
    expect(hsts("test")).toBeUndefined();
  });

  it("lock down framing, plugins, base and form targets in every environment", () => {
    for (const env of ["development", "production", "test"] as const) {
      const csp = contentSecurityPolicy(env);
      for (const directive of [
        "default-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "connect-src 'self'",
      ]) {
        expect(csp).toContain(directive);
      }
    }
  });

  it("allow eval only in development and upgrade requests only in production", () => {
    expect(contentSecurityPolicy("development")).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("production")).not.toContain("'unsafe-eval'");
    expect(contentSecurityPolicy("production")).toContain(
      "upgrade-insecure-requests",
    );
    expect(contentSecurityPolicy("development")).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("are applied to every route by next.config", async () => {
    const rules = await nextConfig.headers!();
    expect(rules).toEqual([
      { source: "/:path*", headers: securityHeaders("test") },
    ]);
    expect(securityHeaders("test").map((h) => h.key)).toEqual([
      "Content-Security-Policy",
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Referrer-Policy",
      "Cross-Origin-Opener-Policy",
      "Permissions-Policy",
    ]);
  });
});
