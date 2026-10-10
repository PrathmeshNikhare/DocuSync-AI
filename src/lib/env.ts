import "server-only";
import { z } from "zod";

// Each group is validated lazily where it is used, so a missing optional feature
// (e.g. GitHub App credentials in fixture mode) never breaks unrelated code or builds.

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/ });

const serverEnvSchema = z.object({ DATABASE_URL: postgresUrl });
export type ServerEnv = z.infer<typeof serverEnvSchema>;

const webhookEnvSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(20),
  // Comma-separated GitHub App installation ids allowed to queue work, e.g. "123,456".
  GITHUB_ALLOWED_INSTALLATION_IDS: z
    .string()
    .regex(/^\s*\d{1,15}\s*(,\s*\d{1,15}\s*)*$/)
    .transform((s) => new Set(s.split(",").map((id) => Number(id.trim())))),
});

const githubAppEnvSchema = z.object({
  GITHUB_APP_ID: z.string().regex(/^\d{1,12}$/),
  // .env files usually hold the PEM on one line with literal "\n" escapes.
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    .transform((k) => k.replace(/\\n/g, "\n"))
    .refine((k) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(k), {
      message: "Not a PEM private key",
    }),
});
export type GitHubAppEnv = z.infer<typeof githubAppEnvSchema>;

const migrationEnvSchema = z.object({ MIGRATION_DATABASE_URL: postgresUrl });

/** Throws an error naming the invalid keys only; values (possibly secrets) are never included. */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  source: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid server environment: ${keys.join(", ")}`);
  }
  return result.data;
}

export function parseServerEnv(
  source: Record<string, string | undefined>,
): ServerEnv {
  return parseEnv(serverEnvSchema, source);
}

let cached: ServerEnv | undefined;

/** Validated lazily on first use so `next build` does not need runtime secrets. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}

export function getWebhookConfig(
  source: Record<string, string | undefined> = process.env,
): { secret: string; allowedInstallationIds: ReadonlySet<number> } {
  const env = parseEnv(webhookEnvSchema, source);
  return {
    secret: env.GITHUB_WEBHOOK_SECRET,
    allowedInstallationIds: env.GITHUB_ALLOWED_INSTALLATION_IDS,
  };
}

export function getGitHubAppEnv(
  source: Record<string, string | undefined> = process.env,
): GitHubAppEnv {
  return parseEnv(githubAppEnvSchema, source);
}

export function getMigrationDatabaseUrl(
  source: Record<string, string | undefined> = process.env,
): string {
  return parseEnv(migrationEnvSchema, source).MIGRATION_DATABASE_URL;
}
