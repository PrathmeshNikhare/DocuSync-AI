// Usage: npm run db:check-grants [-- --require-non-superuser]
// Verifies the app role's privileges match the migrations (owner role,
// MIGRATION_DATABASE_URL). Run after every restore; see docs/10.
// --require-non-superuser (the reference deployment) also fails if the owner role
// itself is a superuser or can create roles or databases.
import { Client } from "pg";
import { checkAppGrants, checkOwnerRole } from "@/lib/db/grants";
import { getMigrationDatabaseUrl } from "@/lib/env";

async function main() {
  const client = new Client({ connectionString: getMigrationDatabaseUrl() });
  await client.connect();
  try {
    const problems = await checkAppGrants(client);
    if (process.argv.includes("--require-non-superuser"))
      problems.push(...(await checkOwnerRole(client)));
    for (const p of problems) console.error(`FAIL ${p}`);
    console.log(
      problems.length
        ? `${problems.length} grant problem(s): the database roles do not match the expected limits.`
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
