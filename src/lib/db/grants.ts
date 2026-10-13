// The app role's limits from migrations 0002–0006, as checkable expectations.
// A restore (or a hand-made database) can silently widen them: pg_restore creates
// tables as the owner, default privileges then grant the app role everything,
// and pg_dump without --create carries no database-level privileges (docs/10,
// "Backup and restore"). `npm run db:check-grants` runs this.

interface Querier {
  query<R extends object>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

const APP = "docusync_app";

/** Whole-table privileges the app role must NOT have. */
const DENIED: Record<string, readonly string[]> = {
  schema_migrations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  review_decisions: ["UPDATE", "DELETE"],
  reviewers: ["INSERT", "UPDATE", "DELETE"],
  repository_reviewers: ["INSERT", "UPDATE", "DELETE"],
  patch_proposals: ["UPDATE", "DELETE"],
  impact_candidates: ["UPDATE", "DELETE"],
  sessions: ["DELETE"],
  github_outputs: ["DELETE"],
  github_output_attempts: ["UPDATE", "DELETE"],
};

/**
 * Tables the app may update only in these columns. Every other column of the
 * table, as the database reports them, must be refused (so new columns are
 * covered without editing this list).
 */
const UPDATE_ONLY: Record<string, readonly string[]> = {
  sessions: ["revoked_at"],
  repositories: ["owner", "name", "installation_id", "updated_at"],
  github_outputs: [
    "step",
    "error_code",
    "commit_sha",
    "pr_number",
    "pr_url",
    "attempts",
    "lease_token",
    "lease_until",
    "updated_at",
  ],
};

/** What the app needs, so a check can't pass by revoking too much. */
const REQUIRED: Record<string, readonly string[]> = {
  analyses: ["SELECT", "INSERT"],
  review_decisions: ["SELECT", "INSERT"],
  sessions: ["SELECT", "INSERT"],
  github_outputs: ["SELECT", "INSERT"],
  github_output_attempts: ["INSERT"],
};

/** Problems with the app role's privileges; empty when they match the migrations. */
export async function checkAppGrants(db: Querier): Promise<string[]> {
  const ask = async (sql: string, params: unknown[]) =>
    (await db.query<{ ok: boolean }>(sql, params)).rows[0]!.ok;
  const table = (t: string, p: string) =>
    ask("SELECT has_table_privilege($1, $2, $3) AS ok", [APP, t, p]);
  const column = (t: string, c: string, p: string) =>
    ask("SELECT has_column_privilege($1, $2, $3, $4) AS ok", [APP, t, c, p]);

  const problems: string[] = [];
  // has_table_privilege ignores column grants, so a denied SELECT, INSERT or
  // UPDATE is also checked on every column (security-check L-2).
  const anyColumn = (t: string, p: string) =>
    ask("SELECT has_any_column_privilege($1, $2, $3) AS ok", [APP, t, p]);
  for (const [t, privs] of Object.entries(DENIED))
    for (const p of privs) {
      const granted =
        p === "DELETE" ? await table(t, p) : await anyColumn(t, p);
      if (granted) problems.push(`app role has ${p} on ${t}`);
    }

  for (const [t, allowed] of Object.entries(UPDATE_ONLY)) {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1`,
      [t],
    );
    for (const { column_name: c } of rows) {
      const can = await column(t, c, "UPDATE");
      if (allowed.includes(c) && !can)
        problems.push(`app role lacks UPDATE on ${t}.${c}`);
      if (!allowed.includes(c) && can)
        problems.push(`app role has UPDATE on ${t}.${c}`);
    }
  }

  const { rows: tables } = await db.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  for (const { tablename } of tables)
    if (await table(tablename, "TRUNCATE"))
      problems.push(`app role has TRUNCATE on ${tablename}`);

  for (const [t, privs] of Object.entries(REQUIRED))
    for (const p of privs)
      if (!(await table(t, p))) problems.push(`app role lacks ${p} on ${t}`);

  // Database- and schema-level limits from 0002 (not carried by pg_dump).
  if (
    await ask(
      "SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS ok",
      [APP],
    )
  )
    problems.push("app role has TEMPORARY on the database");
  if (
    await ask("SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok", [
      APP,
    ])
  )
    problems.push("app role has CREATE on schema public");
  return problems;
}
