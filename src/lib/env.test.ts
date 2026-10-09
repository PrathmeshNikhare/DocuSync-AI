import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

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
