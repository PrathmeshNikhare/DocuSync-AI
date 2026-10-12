import { describe, expect, it } from "vitest";
import {
  DUMMY_HASH,
  hashPassword,
  parseStoredHash,
  verifyPassword,
} from "./password";

describe("stored hash parameters", () => {
  it("accept only costs scrypt can run, and refuse others without throwing", async () => {
    const good = await hashPassword("correct horse battery staple");
    for (const [from, to] of [
      ["$32768$8$", "$65536$8$"], // 64 MiB: over maxmem
      ["$32768$8$", "$131072$8$"],
      ["$32768$8$", "$32768$16$"],
      ["$32768$8$1$", "$32768$8$3$"],
    ]) {
      const stored = good.replace(from!, to!);
      expect(parseStoredHash(stored)).toBeUndefined();
      await expect(
        verifyPassword("correct horse battery staple", stored),
      ).resolves.toBe(false);
    }
  });

  it("include the dummy hash, so an unknown username still costs a real scrypt run", () => {
    expect(parseStoredHash(DUMMY_HASH)).toMatchObject({ n: 32768, r: 8, p: 1 });
  });
});

describe("password hashing", () => {
  it("hashes with a random salt and verifies only the right password", async () => {
    const a = await hashPassword("correct horse battery staple");
    const b = await hashPassword("correct horse battery staple");
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[\w-]{22}\$[\w-]{43}$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", a)).toBe(false);
  });

  it("refuses passwords outside the length rules", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
    await expect(hashPassword("x".repeat(201))).rejects.toThrow();
  });

  it("never verifies against a malformed or out-of-range stored hash", async () => {
    const good = await hashPassword("correct horse battery staple");
    for (const stored of [
      "",
      "plain-text-password",
      good.replace("$32768$", "$2$"), // too cheap
      good.replace("$32768$", "$33554432$"), // too expensive
      good.replace("$32768$", "$30000$"), // not a power of two
      good.slice(0, -5),
    ]) {
      expect(await verifyPassword("correct horse battery staple", stored)).toBe(
        false,
      );
    }
    expect(await verifyPassword("anything at all here", DUMMY_HASH)).toBe(
      false,
    );
  });
});
