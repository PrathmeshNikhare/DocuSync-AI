import { afterEach, describe, expect, it, vi } from "vitest";

describe("getPool", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("creates one pool lazily without connecting", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://u:p@127.0.0.1:1/db");
    const { getPool } = await import("./pool");
    const pool = getPool();
    expect(getPool()).toBe(pool);
    expect(pool.totalCount).toBe(0);
    await pool.end();
  });

  it("throws on invalid environment instead of creating a pool", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { getPool } = await import("./pool");
    expect(() => getPool()).toThrow("Invalid server environment: DATABASE_URL");
  });
});
