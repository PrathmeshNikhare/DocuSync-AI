import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: ["src/**/*.db.test.ts"],
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
    ],
  },
});
