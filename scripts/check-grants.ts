// Usage: npm run db:check-grants
// Verifies the app role's privileges match the migrations (owner role,
// MIGRATION_DATABASE_URL). Run after every restore; see docs/10.
import { Client } from "pg";
import { checkAppGrants } from "@/lib/db/grants";
import { getMigrationDatabaseUrl } from "@/lib/env";

async function main() {
  const client = new Client({ connectionString: getMigrationDatabaseUrl() });
  await client.connect();
  try {
    const problems = await checkAppGrants(client);
    for (const p of problems) console.error(`FAIL ${p}`);
    console.log(
      problems.length
        ? `${problems.length} grant problem(s): the app role's limits do not match the migrations.`
        : "OK: the app role's privileges match the migrations.",
    );
    process.exitCode = problems.length ? 1 : 0;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: unknown })?.code;
  console.error(
    err instanceof Error && err.message.startsWith("Invalid server environment")
      ? err.message
      : typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `CHECK_GRANTS_FAILED (${code})`
        : "CHECK_GRANTS_FAILED",
  );
  process.exit(1);
});
