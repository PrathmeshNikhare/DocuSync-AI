import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/security-headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    const env =
      process.env.NODE_ENV === "production"
        ? "production"
        : process.env.NODE_ENV === "test"
          ? "test"
          : "development";
    return [{ source: "/:path*", headers: securityHeaders(env) }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  // AGENTS.md is a harness-owned file; stop `next dev` from injecting its managed block.
  agentRules: false,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
