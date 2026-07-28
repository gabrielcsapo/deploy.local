import { describe, it, expect, vi } from "vitest";
import { isStaleModuleError, withStaleModuleRetry } from "./stale-module.js";

describe("isStaleModuleError", () => {
  it("matches the closed module runner error", () => {
    expect(isStaleModuleError(new Error("Vite module runner has been closed."))).toBe(true);
  });

  it("matches a restart-in-progress error", () => {
    expect(isStaleModuleError(new Error("The server is being restarted."))).toBe(true);
  });

  it("does not match ordinary application errors", () => {
    expect(isStaleModuleError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleModuleError(undefined)).toBe(false);
  });
});

describe("withStaleModuleRetry", () => {
  it("returns the result without retrying when the call succeeds", async () => {
    const onStale = vi.fn();
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withStaleModuleRetry(fn, onStale)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("evicts caches and retries after a stale-module failure", async () => {
    const onStale = vi.fn();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Vite module runner has been closed."))
      .mockResolvedValue("recovered");

    await expect(withStaleModuleRetry(fn, onStale, [0])).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onStale).toHaveBeenCalledTimes(1);
  });

  it("rethrows non-stale errors immediately", async () => {
    const onStale = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(withStaleModuleRetry(fn, onStale, [0, 0])).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it("gives up after exhausting retries and surfaces the last error", async () => {
    const onStale = vi.fn();
    const fn = vi.fn().mockRejectedValue(new Error("Vite module runner has been closed."));

    await expect(withStaleModuleRetry(fn, onStale, [0, 0])).rejects.toThrow(
      "Vite module runner has been closed.",
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onStale).toHaveBeenCalledTimes(2);
  });
});
