import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Component tests (*.test.tsx) opt into jsdom with a `@vitest-environment` comment.
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server condition; tests run in plain Node.
      "server-only": fileURLToPath(
        new URL("./src/test/server-only-stub.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          // Cold imports of route and pool modules can pass 5 s when the whole suite,
          // jsdom tests included, runs in parallel. No test asserts timing this way.
          testTimeout: 20_000,
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.db.test.ts", "src/**/*.ollama.test.ts"],
        },
      },
      {
        // Needs TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL; fails (never skips) without them.
        extends: true,
        test: {
          name: "db",
          include: ["src/**/*.db.test.ts"],
          fileParallelism: false,
        },
      },
      {
        // Needs OLLAMA_MODEL and a running Ollama; fails (never skips) without them.
        extends: true,
        test: {
          name: "ollama",
          include: ["src/**/*.ollama.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
