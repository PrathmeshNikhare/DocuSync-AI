import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows `limit` hits per window per key, then refuses until the window moves", () => {
    let t = 0;
    const limiter = createRateLimiter(2, 1000, () => t);
    expect([
      limiter.allow("a"),
      limiter.allow("a"),
      limiter.allow("a"),
    ]).toEqual([true, true, false]);
    expect(limiter.allow("b")).toBe(true);
    t = 999;
    expect(limiter.allow("a")).toBe(false);
    t = 1001;
    expect(limiter.allow("a")).toBe(true);
  });

  it("doesn't count refused hits against the window", () => {
    let t = 0;
    const limiter = createRateLimiter(1, 1000, () => t);
    limiter.allow("a");
    for (t = 1; t < 1000; t += 100) limiter.allow("a");
    t = 1001;
    expect(limiter.allow("a")).toBe(true);
  });
});
