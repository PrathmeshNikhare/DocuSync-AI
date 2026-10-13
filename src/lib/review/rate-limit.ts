/**
 * A sliding-window limit per key (a reviewer id). `allow(key)` records a hit and
 * says whether it is within `limit` hits per `windowMs`.
 * ponytail: per-process memory. With several app instances each keeps its own
 * window; move this to the database or a shared store before scaling out.
 */
export function createRateLimiter(
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((h) => h > t - windowMs);
      const ok = recent.length < limit;
      if (ok) recent.push(t);
      hits.set(key, recent);
      return ok;
    },
    reset: () => hits.clear(),
  };
}
