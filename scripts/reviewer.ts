// Operator commands. They use the owner role (MIGRATION_DATABASE_URL), because
// the app role cannot create reviewers or grant access (migration 0003).
//   npm run reviewer:add -- --username alice --name "Alice Example"
//     Prints a generated password once. Store it; it is not shown again.
//   npm run reviewer:grant -- --username alice --repo fixture/env-var-renamed
//   npm run reviewer:unlock -- --username alice   (clears failed sign-ins after a lockout)
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "pg";
import { getMigrationDatabaseUrl } from "@/lib/env";
import { hashPassword } from "@/lib/review/password";
import { usernameSchema } from "@/lib/review/session";

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    username: { type: "string" },
    name: { type: "string" },
    repo: { type: "string" },
  },
});

function usage(): never {
  console.error(
    "Usage: reviewer add --username <name> --name <display name>\n" +
      "       reviewer grant --username <name> --repo <owner>/<repo>\n" +
      "       reviewer unlock --username <name>",
  );
  process.exit(2);
}

async function main() {
  const username = usernameSchema.safeParse(values.username);
  if (!username.success) usage();
  const client = new Client({ connectionString: getMigrationDatabaseUrl() });
  await client.connect();
  try {
    if (command === "add") {
      const display = (values.name ?? "").trim();
      if (display.length < 1 || display.length > 100) usage();
      const password = randomBytes(18).toString("base64url");
      await client.query(
        "INSERT INTO reviewers (username, display_name, password_hash) VALUES ($1, $2, $3)",
        [username.data, display, await hashPassword(password)],
      );
      console.log(
        `Created reviewer ${username.data}. Password (shown once): ${password}`,
      );
    } else if (command === "unlock") {
      // Sign-ins are refused after 5 failures in 15 minutes, which anyone who knows a
      // username can trigger. Clearing the failures lets the reviewer sign in again.
      const cleared = await client.query(
        "DELETE FROM login_failures WHERE username = $1",
        [username.data],
      );
      console.log(
        `Cleared ${cleared.rowCount} failed sign-in(s) for ${username.data}.`,
      );
    } else if (command === "grant") {
      const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(
        values.repo ?? "",
      );
      if (!m) usage();
      const repos = await client.query<{ id: string }>(
        "SELECT id FROM repositories WHERE owner = $1 AND name = $2",
        [m[1], m[2]],
      );
      if (repos.rowCount !== 1) {
        console.error(
          repos.rowCount ? "REPOSITORY_AMBIGUOUS" : "REPOSITORY_NOT_FOUND",
        );
        process.exit(1);
      }
      const granted = await client.query(
        `INSERT INTO repository_reviewers (repository_id, reviewer_id)
         SELECT $1, id FROM reviewers WHERE username = $2
         ON CONFLICT DO NOTHING`,
        [repos.rows[0]!.id, username.data],
      );
      const exists = await client.query(
        "SELECT 1 FROM reviewers WHERE username = $1",
        [username.data],
      );
      if (!exists.rowCount) {
        console.error("REVIEWER_NOT_FOUND");
        process.exit(1);
      }
      console.log(
        granted.rowCount
          ? `Granted ${username.data} access to ${m[1]}/${m[2]}.`
          : `${username.data} already had access to ${m[1]}/${m[2]}.`,
      );
    } else {
      usage();
    }
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  // Driver errors can name the user and host: print only safe messages or codes.
  const code = (err as { code?: unknown })?.code;
  if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  ) {
    console.error(err.message);
  } else if (code === "23505") {
    console.error("REVIEWER_EXISTS");
  } else {
    console.error(
      typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `REVIEWER_COMMAND_FAILED (${code})`
        : "REVIEWER_COMMAND_FAILED",
    );
  }
  process.exit(1);
});
