import "server-only";
import { z } from "zod";

// Each group is validated lazily where it is used, so a missing optional feature
// (e.g. GitHub App credentials in fixture mode) never breaks unrelated code or builds.

const postgresUrl = z.url({ protocol: /^postgres(?:ql)?$/ });

const serverEnvSchema = z.object({ DATABASE_URL: postgresUrl });
export type ServerEnv = z.infer<typeof serverEnvSchema>;

// Comma-separated GitHub App installation ids allowed to queue work, e.g. "123,456".
const allowedInstallationIds = z
  .string()
  .regex(/^\s*\d{1,15}\s*(,\s*\d{1,15}\s*)*$/)
  .transform((s) => new Set(s.split(",").map((id) => Number(id.trim()))));

const webhookEnvSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(20),
  GITHUB_ALLOWED_INSTALLATION_IDS: allowedInstallationIds,
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

// Prompts carry repository content, so the endpoint must not embed credentials
// (they would end up in error paths) and should stay on a private network (docs/07).
// `KEY=` in an env file means "not set": use the default instead of coercing "" to 0.
const unsetIfEmpty = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema);

const isLoopback = (url: string) =>
  /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i.test(new URL(url).hostname);

const ollamaEnvSchema = z
  .object({
    OLLAMA_BASE_URL: unsetIfEmpty(
      z
        .url({ protocol: /^https?$/ })
        .refine((u) => !new URL(u).username && !new URL(u).password, {
          message: "Credentials in the URL are not allowed",
        })
        .default("http://127.0.0.1:11434"),
    ),
    OLLAMA_MODEL: unsetIfEmpty(
      z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/)
        .optional(),
    ),
    OLLAMA_TIMEOUT_MS: unsetIfEmpty(
      z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    ),
    OLLAMA_NUM_CTX: unsetIfEmpty(
      z.coerce.number().int().min(2_048).max(131_072).default(8_192),
    ),
    // Plain http beyond loopback sends repository content unencrypted to a server
    // with no authentication; it must be chosen explicitly.
    OLLAMA_ALLOW_INSECURE_HTTP: unsetIfEmpty(
      z.enum(["true", "false"]).default("false"),
    ),
  })
  .refine(
    (e) =>
      new URL(e.OLLAMA_BASE_URL).protocol === "https:" ||
      isLoopback(e.OLLAMA_BASE_URL) ||
      e.OLLAMA_ALLOW_INSECURE_HTTP === "true",
    {
      message:
        "Use https for a non-loopback Ollama, or set OLLAMA_ALLOW_INSECURE_HTTP",
      path: ["OLLAMA_BASE_URL"],
    },
  );

export interface OllamaEnv {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  numCtx: number;
}

/** Undefined when no model is configured: callers then run deterministic-only. */
export function getOllamaEnv(
  source: Record<string, string | undefined> = process.env,
): OllamaEnv | undefined {
  const env = parseEnv(ollamaEnvSchema, source);
  if (!env.OLLAMA_MODEL) return undefined;
  return {
    baseUrl: env.OLLAMA_BASE_URL,
    model: env.OLLAMA_MODEL,
    timeoutMs: env.OLLAMA_TIMEOUT_MS,
    numCtx: env.OLLAMA_NUM_CTX,
  };
}

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

/** Installation ids the live CLI and the writer may act for. */
export function getAllowedInstallationIds(
  source: Record<string, string | undefined> = process.env,
): ReadonlySet<number> {
  return parseEnv(
    z.object({ GITHUB_ALLOWED_INSTALLATION_IDS: allowedInstallationIds }),
    source,
  ).GITHUB_ALLOWED_INSTALLATION_IDS;
}

/**
 * GitHub writes are off unless this is exactly "true" (docs/13). Read on every
 * call, never cached, so a restarted server with the flag removed can't write.
 */
export const writesEnabled = (
  source: Record<string, string | undefined> = process.env,
): boolean => source.GITHUB_WRITES_ENABLED === "true";

/** The App's slug names its bot account, `<slug>[bot]`, which authors our PRs. */
export function getGitHubAppSlug(
  source: Record<string, string | undefined> = process.env,
): string {
  return parseEnv(
    z.object({ GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]{1,100}$/) }),
    source,
  ).GITHUB_APP_SLUG;
}

export function getMigrationDatabaseUrl(
  source: Record<string, string | undefined> = process.env,
): string {
  return parseEnv(migrationEnvSchema, source).MIGRATION_DATABASE_URL;
}
