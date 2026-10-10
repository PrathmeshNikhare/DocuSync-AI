import { Client, Pool } from "pg";

/** DB tests fail loudly without configuration instead of silently skipping. */
export function requireTestDbUrls(): { appUrl: string; ownerUrl: string } {
  const appUrl = process.env.TEST_DATABASE_URL;
  const ownerUrl = process.env.TEST_MIGRATION_DATABASE_URL;
  if (!appUrl || !ownerUrl) {
    throw new Error(
      "npm run test:db needs TEST_DATABASE_URL and TEST_MIGRATION_DATABASE_URL (see .env.example)",
    );
  }
  for (const url of [appUrl, ownerUrl]) {
    // Guard against pointing destructive test setup at a non-test database.
    if (!new URL(url).pathname.endsWith("_test")) {
      throw new Error("Test database names must end in _test");
    }
  }
  return { appUrl, ownerUrl };
}

export async function withOwner<T>(
  ownerUrl: string,
  fn: (c: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export const appPool = (appUrl: string) =>
  new Pool({ connectionString: appUrl, max: 5 });
