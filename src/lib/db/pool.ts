import "server-only";
import { Pool } from "pg";
import { getServerEnv } from "@/lib/env";

let pool: Pool | undefined;

/** Lazily creates the shared pool. Constructing it does not open a connection. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getServerEnv().DATABASE_URL,
      max: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      // Server-side cap so a slow query cannot hold a request or connection open.
      statement_timeout: 10_000,
      // Ends sessions that stall mid-transaction and would otherwise hold locks.
      idle_in_transaction_session_timeout: 10_000,
    });
    // Without a listener, an idle-client error crashes the process. Log the code only:
    // pg error messages can echo connection details.
    pool.on("error", (err: Error & { code?: string }) => {
      console.error(
        JSON.stringify({ event: "pg_pool_error", code: err.code ?? "UNKNOWN" }),
      );
    });
  }
  return pool;
}
