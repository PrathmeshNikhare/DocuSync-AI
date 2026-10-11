import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getGitHubAppEnv,
  getMigrationDatabaseUrl,
  getOllamaEnv,
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

describe("getOllamaEnv", () => {
  it("is undefined when no model is configured (deterministic-only)", () => {
    expect(getOllamaEnv({})).toBeUndefined();
    expect(getOllamaEnv({ OLLAMA_MODEL: "" })).toBeUndefined();
  });

  it("requires https beyond loopback unless insecure http is chosen explicitly", () => {
    const at =
      (url: string, extra: Record<string, string> = {}) =>
      () =>
        getOllamaEnv({ OLLAMA_MODEL: "m", OLLAMA_BASE_URL: url, ...extra });
    for (const ok of [
      "http://127.0.0.1:11434",
      "http://localhost:11434",
      "http://[::1]:11434",
      "https://ollama.example.com",
    ]) {
      expect(at(ok)).not.toThrow();
    }
    for (const bad of ["http://10.0.0.5:11434", "http://ollama.example.com"]) {
      expect(at(bad)).toThrow("Invalid server environment: OLLAMA_BASE_URL");
      expect(at(bad, { OLLAMA_ALLOW_INSECURE_HTTP: "true" })).not.toThrow();
    }
    expect(
      at("http://10.0.0.5", { OLLAMA_ALLOW_INSECURE_HTTP: "yes" }),
    ).toThrow("OLLAMA_ALLOW_INSECURE_HTTP");
  });

  it("treats empty values (KEY= in an env file) as unset", () => {
    expect(
      getOllamaEnv({
        OLLAMA_MODEL: "llama3.2:3b",
        OLLAMA_BASE_URL: "",
        OLLAMA_TIMEOUT_MS: "",
        OLLAMA_NUM_CTX: "",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2:3b",
      timeoutMs: 120_000,
      numCtx: 8_192,
    });
  });

  it("parses the shipped .env.example without errors", () => {
    const example = Object.fromEntries(
      readFileSync(".env.example", "utf8")
        .split("\n")
        .filter((l) => /^OLLAMA_[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(Object.keys(example).length).toBeGreaterThanOrEqual(4);
    expect(getOllamaEnv(example)).toBeUndefined(); // no model by default
    expect(getOllamaEnv({ ...example, OLLAMA_MODEL: "m" })).toMatchObject({
      timeoutMs: 120_000,
      numCtx: 8_192,
    });
  });

  it("applies defaults and coerces numbers", () => {
    expect(getOllamaEnv({ OLLAMA_MODEL: "llama3.2:3b" })).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      model: "llama3.2:3b",
      timeoutMs: 120_000,
      numCtx: 8_192,
    });
    expect(
      getOllamaEnv({
        OLLAMA_MODEL: "qwen2.5-coder:7b",
        OLLAMA_BASE_URL: "http://ollama.internal:11434",
        OLLAMA_ALLOW_INSECURE_HTTP: "true",
        OLLAMA_TIMEOUT_MS: "5000",
        OLLAMA_NUM_CTX: "4096",
      }),
    ).toMatchObject({ timeoutMs: 5000, numCtx: 4096 });
  });

  it.each([
    ["OLLAMA_BASE_URL", `http://u:${SECRET}@127.0.0.1:11434`],
    ["OLLAMA_BASE_URL", "file:///etc/passwd"],
    ["OLLAMA_MODEL", "--model;rm"],
    ["OLLAMA_TIMEOUT_MS", "0"],
    ["OLLAMA_NUM_CTX", "lots"],
  ])("rejects a bad %s without echoing the value", (key, value) => {
    const run = () => getOllamaEnv({ OLLAMA_MODEL: "llama3", [key]: value });
    expect(run).toThrow(`Invalid server environment: ${key}`);
    expect(run).not.toThrow(SECRET);
  });
});
