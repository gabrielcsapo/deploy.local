import { describe, it, expect, vi } from "vitest";
import { isStaleModuleError, withStaleModuleRetry } from "./stale-module.js";

describe("isStaleModuleError", () => {
  it("matches the closed module runner error", () => {
    expect(isStaleModuleError(new Error("Vite module runner has been closed."))).toBe(true);
  });

  it("matches a restart-in-progress error", () => {
    expect(isStaleModuleError(new Error("The server is being restarted."))).toBe(true);
  });

  it("matches a disconnected module-runner transport", () => {
    expect(
      isStaleModuleError(new Error('transport was disconnected, cannot call "fetchModule"')),
    ).toBe(true);
  });

  it("matches an error revived as a plain object", () => {
    expect(
      isStaleModuleError({ message: 'transport was disconnected, cannot call "fetchModule"' }),
    ).toBe(true);
  });

  it("matches a stale-module error wrapped as a cause", () => {
    const wrapped = new Error("Failed to load url /app/routes.ts", {
      cause: new Error('transport was disconnected, cannot call "fetchModule"'),
    });
    expect(isStaleModuleError(wrapped)).toBe(true);
  });

  it("matches a stale-module error inside an AggregateError", () => {
    const aggregate = new AggregateError(
      [new Error("boom"), new Error("Vite module runner has been closed.")],
      "import failed",
    );
    expect(isStaleModuleError(aggregate)).toBe(true);
  });

  it("does not match ordinary application errors", () => {
    expect(isStaleModuleError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleModuleError(undefined)).toBe(false);
  });

  it("does not match an application error wrapping another application error", () => {
    const wrapped = new Error("render failed", { cause: new Error("undefined is not a function") });
    expect(isStaleModuleError(wrapped)).toBe(false);
  });

  it("terminates on a circular cause chain", () => {
    const a = new Error("a") as Error & { cause?: unknown };
    const b = new Error("b") as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a;
    expect(isStaleModuleError(a)).toBe(false);
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
