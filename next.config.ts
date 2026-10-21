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
  // Keep `next dev` from writing agent instructions into the repository (it would create
  // or edit an AGENTS.md block). This project keeps no such file in the public tree.
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
