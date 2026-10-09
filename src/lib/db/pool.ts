import "server-only";
import { Pool } from "pg";
import { getServerEnv } from "@/lib/env";

let pool: Pool | undefined;

/** Lazily creates the shared pool. Constructing it does not open a connection. */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getServerEnv().DATABASE_URL, max: 10 });
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
