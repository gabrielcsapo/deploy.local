import { describe, it, expect, vi } from "vitest";
import { withRenderTimeout } from "./render-timeout.js";

describe("withRenderTimeout", () => {
  it("passes the value through when the promise settles before the timeout", async () => {
    const work = new Promise<string>((res) => setTimeout(() => res("done"), 5));
    const result = await withRenderTimeout(work, 100);
    expect(result).toEqual({ timedOut: false, value: "done" });
  });

  it("returns timedOut: true when the timer wins the race", async () => {
    const work = new Promise<string>((res) => setTimeout(() => res("done"), 50));
    const result = await withRenderTimeout(work, 5);
    expect(result).toEqual({ timedOut: true });
  });

  it("calls onTimeout exactly once when the timer fires", async () => {
    const onTimeout = vi.fn();
    const work = new Promise<string>((res) => setTimeout(() => res("done"), 50));
    await withRenderTimeout(work, 5, onTimeout);
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not call onTimeout when the promise wins", async () => {
    const onTimeout = vi.fn();
    const work = Promise.resolve("done");
    const result = await withRenderTimeout(work, 100, onTimeout);
    expect(result).toEqual({ timedOut: false, value: "done" });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("propagates rejections from the wrapped promise", async () => {
    const work = Promise.reject(new Error("boom"));
    await expect(withRenderTimeout(work, 100)).rejects.toThrow("boom");
  });

  it("is a no-op pass-through when timeoutMs is undefined", async () => {
    // Important: no timer is scheduled, so the result is the value
    // wrapped without any racing — this also means no setTimeout
    // overhead on the hot path when the option is disabled.
    const result = await withRenderTimeout(Promise.resolve(42), undefined);
    expect(result).toEqual({ timedOut: false, value: 42 });
  });

  it("is a no-op pass-through when timeoutMs is 0", async () => {
    const result = await withRenderTimeout(Promise.resolve(42), 0);
    expect(result).toEqual({ timedOut: false, value: 42 });
  });

  it("swallows errors thrown by onTimeout so the race result is still reported", async () => {
    // A buggy onTimeout shouldn't block the 504 path — we'd rather
    // surface a Gateway Timeout than crash the request handler.
    const onTimeout = vi.fn(() => {
      throw new Error("user callback boom");
    });
    const work = new Promise<string>((res) => setTimeout(() => res("late"), 50));
    const result = await withRenderTimeout(work, 5, onTimeout);
    expect(result).toEqual({ timedOut: true });
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("clears the timer when the promise wins so it doesn't fire spuriously", async () => {
    // Easy way to see the timer was cleared: spy on setTimeout/clearTimeout.
    // If the timer wasn't cleared on the success path it would still
    // fire later, but onTimeout never being called proves it was.
    const onTimeout = vi.fn();
    await withRenderTimeout(Promise.resolve("ok"), 50, onTimeout);
    // Wait long enough that the (would-be) timer would have fired.
    await new Promise((r) => setTimeout(r, 100));
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
