import { describe, it, expect } from "vitest";
import { redirect, RedirectError } from "./redirect.js";

describe("redirect", () => {
  it("throws a RedirectError", () => {
    expect(() => redirect("/login")).toThrow(RedirectError);
  });

  it("defaults to 302", () => {
    try {
      redirect("/login");
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectError);
      expect((err as RedirectError).status).toBe(302);
    }
  });

  it("accepts 301 status", () => {
    try {
      redirect("/login", 301);
    } catch (err) {
      expect(err).toBeInstanceOf(RedirectError);
      expect((err as RedirectError).status).toBe(301);
    }
  });

  it("stores the destination URL", () => {
    try {
      redirect("/dashboard");
    } catch (err) {
      expect((err as RedirectError).destination).toBe("/dashboard");
    }
  });

  it("is typed as never so return redirect() satisfies any return type", () => {
    // Because redirect() is typed as `never`, `return redirect(...)` is valid
    // in a function with any return type — TypeScript treats never as assignable
    // to everything, making the early-exit pattern work without a type error.
    function getUser(): string {
      return redirect("/login");
    }
    expect(() => getUser()).toThrow(RedirectError);
  });
});
