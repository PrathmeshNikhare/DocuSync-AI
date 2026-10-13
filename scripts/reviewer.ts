// Operator commands. They use the owner role (MIGRATION_DATABASE_URL), because
// the app role cannot create reviewers, grant access or delete sessions.
//   npm run reviewer:add -- --username alice --name "Alice Example" --password-file ./alice.pw
//     Writes a generated password to a new file (mode 0600); it is never printed.
//   npm run reviewer:grant -- --username alice --repo fixture/env-var-renamed
//   npm run reviewer:revoke -- --username alice --repo fixture/env-var-renamed
//   npm run reviewer:disable -- --username alice   (sessions stop working at once)
//   npm run reviewer:enable -- --username alice
//   npm run reviewer:unlock -- --username alice    (clears failed sign-ins after a lockout)
//   npm run sessions:prune                          (deletes expired and revoked sessions)
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, unlinkSync, writeSync } from "node:fs";
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
    "password-file": { type: "string" },
  },
});

function usage(): never {
  console.error(
    [
      "Usage: reviewer add --username <name> --name <display name> --password-file <new file>",
      "       reviewer grant|revoke --username <name> --repo <owner>/<repo>",
      "       reviewer disable|enable|unlock --username <name>",
      "       reviewer prune-sessions",
    ].join("\n"),
  );
  process.exit(2);
}

function fail(code: string): never {
  console.error(code);
  process.exit(1);
}

const requireUsername = () => {
  const u = usernameSchema.safeParse(values.username);
  return u.success ? u.data : usage();
};

/** The one repository named owner/name (a fixture and a GitHub repo can share a name). */
async function repositoryId(client: Client): Promise<string> {
  const m = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(
    values.repo ?? "",
  );
  if (!m) usage();
  const repos = await client.query<{ id: string }>(
    "SELECT id FROM repositories WHERE owner = $1 AND name = $2",
    [m[1], m[2]],
  );
  if (repos.rowCount !== 1)
    fail(repos.rowCount ? "REPOSITORY_AMBIGUOUS" : "REPOSITORY_NOT_FOUND");
  return repos.rows[0]!.id;
}

async function reviewerId(client: Client, username: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM reviewers WHERE username = $1",
    [username],
  );
  return rows[0]?.id ?? fail("REVIEWER_NOT_FOUND");
}

async function main() {
  if (command === "prune-sessions") {
    const client = new Client({ connectionString: getMigrationDatabaseUrl() });
    await client.connect();
    try {
      const pruned = await client.query(
        "DELETE FROM sessions WHERE revoked_at IS NOT NULL OR expires_at <= now()",
      );
      console.log(`Deleted ${pruned.rowCount} expired or revoked session(s).`);
    } finally {
      await client.end();
    }
    return;
  }

  const username = requireUsername();
  const client = new Client({ connectionString: getMigrationDatabaseUrl() });
  await client.connect();
  try {
    if (command === "add") {
      const display = (values.name ?? "").trim();
      const file = values["password-file"];
      if (display.length < 1 || display.length > 100 || !file) usage();
      // Create the file first ("wx": never overwrite one), so a bad path fails before
      // the account exists. Mode 0600 is honoured on POSIX only.
      const fd = openSync(file, "wx", 0o600);
      const password = randomBytes(18).toString("base64url");
      // The account commits only after the password is on disk, so a failed write
      // can't leave an account nobody knows the password of (/review L9).
      try {
        await client.query("BEGIN");
        await client.query(
          "INSERT INTO reviewers (username, display_name, password_hash) VALUES ($1, $2, $3)",
          [username, display, await hashPassword(password)],
        );
        writeSync(fd, `${password}\n`);
        fsyncSync(fd);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        closeSync(fd);
        unlinkSync(file); // no account, so no password to keep
        throw err;
      }
      closeSync(fd);
      console.log(`Created reviewer ${username}. Password written to ${file}.`);
    } else if (command === "grant" || command === "revoke") {
      const repo = await repositoryId(client);
      const reviewer = await reviewerId(client, username);
      const changed =
        command === "grant"
          ? await client.query(
              `INSERT INTO repository_reviewers (repository_id, reviewer_id)
               VALUES ($1, $2) ON CONFLICT DO NOTHING`,
              [repo, reviewer],
            )
          : await client.query(
              "DELETE FROM repository_reviewers WHERE repository_id = $1 AND reviewer_id = $2",
              [repo, reviewer],
            );
      console.log(
        command === "grant"
          ? changed.rowCount
            ? `Granted ${username} access to ${values.repo}.`
            : `${username} already had access to ${values.repo}.`
          : changed.rowCount
            ? `Revoked ${username}'s access to ${values.repo}.`
            : `${username} had no access to ${values.repo}.`,
      );
    } else if (command === "disable" || command === "enable") {
      const changed = await client.query(
        command === "disable"
          ? "UPDATE reviewers SET disabled_at = now() WHERE username = $1 AND disabled_at IS NULL"
          : "UPDATE reviewers SET disabled_at = NULL WHERE username = $1 AND disabled_at IS NOT NULL",
        [username],
      );
      await reviewerId(client, username); // REVIEWER_NOT_FOUND for an unknown name
      console.log(
        changed.rowCount
          ? `${command === "disable" ? "Disabled" : "Enabled"} ${username}.`
          : `${username} was already ${command}d.`,
      );
    } else if (command === "unlock") {
      // Sign-ins are refused after 5 failures in 15 minutes, which anyone who knows a
      // username can trigger. Clearing the failures lets the reviewer sign in again.
      const cleared = await client.query(
        "DELETE FROM login_failures WHERE username = $1",
        [username],
      );
      console.log(
        `Cleared ${cleared.rowCount} failed sign-in(s) for ${username}.`,
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
  } else if (code === "EEXIST") {
    console.error(
      "PASSWORD_FILE_EXISTS (nothing was created; choose a new file)",
    );
  } else {
    console.error(
      typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `REVIEWER_COMMAND_FAILED (${code})`
        : "REVIEWER_COMMAND_FAILED",
    );
  }
  process.exit(1);
});
