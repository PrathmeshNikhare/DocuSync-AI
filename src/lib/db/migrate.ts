import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ClientBase } from "pg";

export const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** Runner errors with messages we wrote (safe to print), unlike raw driver errors. */
export class MigrationError extends Error {
  override name = "MigrationError";
}

// Arbitrary constant; serializes concurrent migration runs against one database.
const ADVISORY_LOCK_ID = 7_001_001;

/**
 * Applies pending `NNNN_name.sql` files in lexical order, each in its own
 * transaction, and records them in `schema_migrations` (D-007). Any other `.sql`
 * file in the directory is an error rather than being silently skipped.
 * Must run as the schema owner, never as the app role.
 */
export async function migrate(
  client: ClientBase,
  dir: string,
): Promise<string[]> {
  const sqlFiles = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const misnamed = sqlFiles.filter((f) => !MIGRATION_FILE.test(f));
  if (misnamed.length > 0) {
    throw new MigrationError(
      `Misnamed migration files: ${misnamed.join(", ")}`,
    );
  }

  await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_ID]);
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.name));
    const applied: string[] = [];

    for (const file of sqlFiles) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [
          file,
        ]);
        await client.query("COMMIT");
      } catch (err) {
        // A failed ROLLBACK must not replace the error that caused it.
        await client.query("ROLLBACK").catch(() => {});
        throw new MigrationError(`Migration ${file} failed`, { cause: err });
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]);
  }
}
