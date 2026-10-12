// Response headers for every route (next.config.ts). The CSP has no nonce: nonces
// are incompatible with Cache Components' static shell, so script-src allows
// 'unsafe-inline' for Next's inline scripts (D-012). Untrusted text is only ever
// rendered as React text, never as HTML, so this CSP is defence in depth.

export function contentSecurityPolicy(
  env: "development" | "production" | "test",
): string {
  return [
    "default-src 'self'",
    // React uses eval for error overlays in development only.
    `script-src 'self' 'unsafe-inline'${env === "development" ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    // Upgrading http://localhost in development would break the dev server.
    ...(env === "production" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

export function securityHeaders(
  env: "development" | "production" | "test",
): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(env) },
    // Production only: development is plain http, and HSTS would pin localhost to https.
    ...(env === "production"
      ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
      : []),
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "no-referrer" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    },
  ];
}
