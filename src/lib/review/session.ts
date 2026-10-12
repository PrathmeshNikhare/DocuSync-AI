import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { DUMMY_HASH, verifyPassword } from "./password";

export const SESSION_TTL_HOURS = 12;
/** Failed logins allowed per username in the window before further tries are refused. */
export const LOGIN_LIMIT = { failures: 5, windowMinutes: 15 } as const;
/**
 * Sign-ins checked at once in this process. Each holds a database connection and
 * a scrypt run (32 MiB), so a flood can't take the pool the webhook also uses;
 * attempts beyond this are refused at once rather than queued.
 */
export const MAX_CONCURRENT_LOGINS = 4;
/** Live sessions kept per reviewer; a new sign-in revokes the oldest beyond this. */
export const MAX_SESSIONS_PER_REVIEWER = 10;
let activeLogins = 0;

export const usernameSchema = z.string().regex(/^[a-z0-9][a-z0-9_.-]{1,38}$/);
// 43 base64url characters = 32 random bytes.
const tokenSchema = z.string().regex(/^[\w-]{43}$/);

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export interface Reviewer {
  id: string;
  username: string;
  displayName: string;
}

export type LoginResult =
  | { ok: true; token: string; reviewer: Reviewer }
  | { ok: false; code: "INVALID_CREDENTIALS" | "RATE_LIMITED" | "BUSY" };

/**
 * Checks a username and password and creates a session. The same generic error
 * covers an unknown user, a wrong password and a disabled account.
 */
export async function login(
  pool: Pool,
  username: string,
  password: string,
): Promise<LoginResult> {
  // No account can have a malformed name, so refusing it at once reveals nothing,
  // and it costs an attacker's flood no scrypt run and no database work.
  const name = usernameSchema.safeParse(username);
  if (!name.success) return { ok: false, code: "INVALID_CREDENTIALS" };
  if (activeLogins >= MAX_CONCURRENT_LOGINS) return { ok: false, code: "BUSY" };
  activeLogins++;
  try {
    return await checkLogin(pool, name.data, password);
  } finally {
    activeLogins--;
  }
}

async function checkLogin(
  pool: Pool,
  username: string,
  password: string,
): Promise<LoginResult> {
  const attemptId = await reserveAttempt(pool, username);
  if (!attemptId) return { ok: false, code: "RATE_LIMITED" };
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string;
    password_hash: string;
    disabled_at: Date | null;
  }>(
    "SELECT id, username, display_name, password_hash, disabled_at FROM reviewers WHERE username = $1",
    [username],
  );
  const row = rows[0];
  const valid = await verifyPassword(
    password,
    row?.password_hash ?? DUMMY_HASH,
  );
  // A failed attempt keeps its reserved row as the recorded failure.
  if (!row || !valid || row.disabled_at) {
    return { ok: false, code: "INVALID_CREDENTIALS" };
  }
  await pool.query("DELETE FROM login_failures WHERE id = $1", [attemptId]);
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (token_hash, reviewer_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [hashToken(token), row.id, SESSION_TTL_HOURS],
  );
  // At most MAX_SESSIONS_PER_REVIEWER live sessions: signing in revokes the oldest.
  await pool.query(
    `UPDATE sessions SET revoked_at = now() WHERE token_hash IN (
       SELECT token_hash FROM sessions
        WHERE reviewer_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC, token_hash OFFSET $2)`,
    [row.id, MAX_SESSIONS_PER_REVIEWER],
  );
  return {
    ok: true,
    token,
    reviewer: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
    },
  };
}

/**
 * Records an attempt as a failure before the password is checked, if the username
 * is under its limit; returns its id, or undefined when rate limited. Counting and
 * recording happen under a per-username lock, so parallel guesses can't all pass
 * the count. Old rows are pruned as new ones arrive, so the table stays small.
 */
async function reserveAttempt(
  pool: Pool,
  username: string,
): Promise<string | undefined> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `login:${username}`,
    ]);
    const { rows } = await client.query<{ id: string }>(
      `WITH pruned AS (DELETE FROM login_failures WHERE attempted_at < now() - interval '1 day')
       INSERT INTO login_failures (username)
       SELECT $1 WHERE (
         SELECT count(*) FROM login_failures
          WHERE username = $1 AND attempted_at > now() - make_interval(mins => $2)
       ) < $3
       RETURNING id`,
      [username, LOGIN_LIMIT.windowMinutes, LOGIN_LIMIT.failures],
    );
    await client.query("COMMIT");
    return rows[0]?.id;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** The reviewer for a live session, or undefined (expired, revoked, disabled or unknown). */
export async function reviewerForToken(
  pool: Pool,
  token: string | undefined,
): Promise<Reviewer | undefined> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return undefined;
  const { rows } = await pool.query<{
    id: string;
    username: string;
    display_name: string;
  }>(
    `SELECT r.id, r.username, r.display_name
       FROM sessions s JOIN reviewers r ON r.id = s.reviewer_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        AND s.expires_at > now() AND r.disabled_at IS NULL`,
    [hashToken(parsed.data)],
  );
  const r = rows[0];
  return r && { id: r.id, username: r.username, displayName: r.display_name };
}

export async function revokeSession(pool: Pool, token: string | undefined) {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) return;
  await pool.query(
    "UPDATE sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
    [hashToken(parsed.data)],
  );
}
