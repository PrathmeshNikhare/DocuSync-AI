import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appPool, requireTestDbUrls, withOwner } from "@/test/db";
import { migrate } from "./migrate";

const { appUrl, ownerUrl } = requireTestDbUrls();
const MIGRATIONS = path.join(process.cwd(), "migrations");

const resetSchema = (c: { query: (sql: string) => Promise<unknown> }) =>
  c.query(
    `DROP TABLE IF EXISTS github_output_attempts, github_outputs,
       review_decisions, patch_proposals, impact_candidates,
       repository_reviewers, login_failures, sessions, reviewers,
       analyses, pull_requests, repositories, schema_migrations CASCADE`,
  );

describe("migrate", () => {
  it("applies all migrations once, then nothing on re-run", async () => {
    await withOwner(ownerUrl, async (c) => {
      await resetSchema(c);
      expect(await migrate(c, MIGRATIONS)).toEqual([
        "0001_ingestion.sql",
        "0002_restrict_app_role.sql",
        "0003_review.sql",
        "0004_review_hardening.sql",
        "0005_github_writes.sql",
      ]);
      expect(await migrate(c, MIGRATIONS)).toEqual([]);
      const { rows } = await c.query<{ name: string }>(
        "SELECT name FROM schema_migrations",
      );
      expect(rows.map((r) => r.name).sort()).toEqual([
        "0001_ingestion.sql",
        "0002_restrict_app_role.sql",
        "0003_review.sql",
        "0004_review_hardening.sql",
        "0005_github_writes.sql",
      ]);
    });
  });

  it("rolls back a failing migration and records nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
    await writeFile(
      path.join(dir, "0001_ok.sql"),
      "CREATE TABLE mig_probe (id int);",
    );
    await writeFile(
      path.join(dir, "0002_bad.sql"),
      "CREATE TABLE mig_probe2 (id int); SELECT broken syntax here;",
    );
    await withOwner(ownerUrl, async (c) => {
      await c.query(
        "DROP TABLE IF EXISTS mig_probe, mig_probe2, schema_migrations",
      );
      await expect(migrate(c, dir)).rejects.toThrow(
        "Migration 0002_bad.sql failed",
      );
      const { rows } = await c.query<{ name: string }>(
        "SELECT name FROM schema_migrations",
      );
      expect(rows.map((r) => r.name)).toEqual(["0001_ok.sql"]);
      const probe2 = await c.query("SELECT to_regclass('mig_probe2') AS t");
      expect(probe2.rows[0]).toEqual({ t: null });
      await c.query("DROP TABLE IF EXISTS mig_probe, schema_migrations");
      // Restore the real schema for the other DB tests.
      await resetSchema(c);
      await migrate(c, MIGRATIONS);
    });
  });

  it("refuses misnamed migration files", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "mig-"));
    await writeFile(path.join(dir, "add-table.sql"), "SELECT 1;");
    await withOwner(ownerUrl, async (c) => {
      await expect(migrate(c, dir)).rejects.toThrow(
        "Misnamed migration files: add-table.sql",
      );
    });
  });
});

describe("app role privileges", () => {
  it("can read and write rows but cannot change the schema", async () => {
    const pool = appPool(appUrl);
    try {
      await expect(
        pool.query("SELECT count(*) FROM analyses"),
      ).resolves.toBeDefined();
      for (const ddl of [
        "CREATE TABLE app_should_not_create (id int)",
        "DROP TABLE analyses",
        "ALTER TABLE analyses ADD COLUMN x int",
        "TRUNCATE analyses",
        // Migration ledger and temp tables are off limits too (migration 0002).
        "SELECT * FROM schema_migrations",
        "DELETE FROM schema_migrations",
        "INSERT INTO schema_migrations (name) VALUES ('9999_fake.sql')",
        "CREATE TEMP TABLE app_tmp (id int)",
      ]) {
        // 42501 = insufficient_privilege
        await expect(pool.query(ddl), ddl).rejects.toMatchObject({
          code: "42501",
        });
      }
    } finally {
      await pool.end();
    }
  });
});
