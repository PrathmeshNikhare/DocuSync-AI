import { describe, expect, it } from "vitest";
import {
  getGitHubAppEnv,
  getMigrationDatabaseUrl,
  getWebhookConfig,
  parseServerEnv,
} from "./env";

const SECRET = "s3cr3t-pa55word";

describe("parseServerEnv", () => {
  it("accepts postgres and postgresql URLs", () => {
    for (const scheme of ["postgres", "postgresql"]) {
      const url = `${scheme}://u:${SECRET}@localhost:5432/db`;
      expect(parseServerEnv({ DATABASE_URL: url }).DATABASE_URL).toBe(url);
    }
  });

  it("rejects a missing DATABASE_URL", () => {
    expect(() => parseServerEnv({})).toThrow(
      "Invalid server environment: DATABASE_URL",
    );
  });

  it("rejects non-postgres and malformed URLs", () => {
    for (const DATABASE_URL of [`mysql://u:${SECRET}@h/db`, "not a url"]) {
      expect(() => parseServerEnv({ DATABASE_URL })).toThrow(
        "Invalid server environment: DATABASE_URL",
      );
    }
  });

  it("never includes the invalid value in the error", () => {
    expect(() =>
      parseServerEnv({ DATABASE_URL: `http://u:${SECRET}@h/db` }),
    ).toThrow(/^Invalid server environment: DATABASE_URL$/);
  });
});

describe("getWebhookConfig", () => {
  const ok = {
    GITHUB_WEBHOOK_SECRET: "x".repeat(20),
    GITHUB_ALLOWED_INSTALLATION_IDS: "123",
  };

  it("returns the secret and a parsed installation allowlist", () => {
    expect(getWebhookConfig(ok)).toEqual({
      secret: "x".repeat(20),
      allowedInstallationIds: new Set([123]),
    });
    expect(
      getWebhookConfig({
        ...ok,
        GITHUB_ALLOWED_INSTALLATION_IDS: " 1, 22 ,333 ",
      }).allowedInstallationIds,
    ).toEqual(new Set([1, 22, 333]));
  });

  it("rejects missing or short secrets without echoing them", () => {
    expect(() =>
      getWebhookConfig({ ...ok, GITHUB_WEBHOOK_SECRET: undefined }),
    ).toThrow(/^Invalid server environment: GITHUB_WEBHOOK_SECRET$/);
    expect(() =>
      getWebhookConfig({ ...ok, GITHUB_WEBHOOK_SECRET: SECRET }),
    ).toThrow(/^Invalid server environment: GITHUB_WEBHOOK_SECRET$/);
  });

  it.each([undefined, "", "abc", "1,,2", "1;2", "-5", "*"])(
    "requires a well-formed allowlist (rejects %j)",
    (ids) => {
      expect(() =>
        getWebhookConfig({ ...ok, GITHUB_ALLOWED_INSTALLATION_IDS: ids }),
      ).toThrow(
        /^Invalid server environment: GITHUB_ALLOWED_INSTALLATION_IDS$/,
      );
    },
  );
});

describe("getGitHubAppEnv", () => {
  const pemOneLine =
    "-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----";
  it("expands escaped newlines in a one-line PEM", () => {
    const env = getGitHubAppEnv({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: pemOneLine,
    });
    expect(env.GITHUB_APP_PRIVATE_KEY).toBe(
      "-----BEGIN PRIVATE KEY-----\nMIIEabc\n-----END PRIVATE KEY-----",
    );
  });
  it("rejects a non-numeric app id and a non-PEM key, naming keys only", () => {
    expect(() =>
      getGitHubAppEnv({ GITHUB_APP_ID: "abc", GITHUB_APP_PRIVATE_KEY: SECRET }),
    ).toThrow(
      /^Invalid server environment: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY$/,
    );
  });
});

describe("getMigrationDatabaseUrl", () => {
  it("requires a postgres URL", () => {
    expect(
      getMigrationDatabaseUrl({
        MIGRATION_DATABASE_URL: "postgres://o:p@h/db",
      }),
    ).toBe("postgres://o:p@h/db");
    expect(() => getMigrationDatabaseUrl({})).toThrow(
      /^Invalid server environment: MIGRATION_DATABASE_URL$/,
    );
  });
});
