// Usage: npm run db:migrate   (reads MIGRATION_DATABASE_URL, e.g. from .env.local)
import path from "node:path";
import { Client } from "pg";
import { MigrationError, migrate } from "@/lib/db/migrate";
import { getMigrationDatabaseUrl } from "@/lib/env";

async function main() {
  const client = new Client({ connectionString: getMigrationDatabaseUrl() });
  await client.connect();
  try {
    const applied = await migrate(
      client,
      path.join(process.cwd(), "migrations"),
    );
    console.log(
      applied.length
        ? `Applied: ${applied.join(", ")}`
        : "No pending migrations",
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // Our own messages (migration name, invalid env keys) are safe to print. Driver
  // errors can name the user and host, so print only their code.
  if (
    err instanceof MigrationError ||
    (err instanceof Error &&
      err.message.startsWith("Invalid server environment"))
  ) {
    console.error(err.message);
  } else {
    const code = (err as { code?: unknown })?.code;
    console.error(
      typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `MIGRATE_FAILED (${code})`
        : "MIGRATE_FAILED",
    );
  }
  process.exit(1);
});
