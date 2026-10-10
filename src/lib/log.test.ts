import { afterEach, describe, expect, it, vi } from "vitest";
import { logEvent, type LogFields } from "./log";

afterEach(() => vi.restoreAllMocks());

describe("logEvent", () => {
  it("emits one JSON line with only the allowed string fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Simulates a caller bypassing the type with extra or non-string fields.
    const fields = {
      requestId: "r1",
      code: "OK",
      payload: { secret: "hunter2" },
      authorization: "Bearer abc",
      outcome: { nested: "object" },
    } as unknown as LogFields;
    logEvent("test", fields);
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]![0])) as Record<
      string,
      unknown
    >;
    expect(Object.keys(line).sort()).toEqual([
      "code",
      "name",
      "requestId",
      "ts",
    ]);
    expect(String(spy.mock.calls[0]![0])).not.toMatch(/hunter2|Bearer|nested/);
  });
});
