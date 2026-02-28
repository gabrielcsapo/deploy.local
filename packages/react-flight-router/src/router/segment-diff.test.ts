import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffSegments } from "./segment-diff.js";
import type { RouteMatch, RouteConfig } from "./types.js";

const noop = () => Promise.resolve({ default: () => null });

function makeMatch(
  id: string,
  segmentKey: string,
  params: Record<string, string> = {},
): RouteMatch {
  const route: RouteConfig = { id, component: noop };
  return { route, params, pathname: `/${id}`, segmentKey };
}

describe("diffSegments", () => {
  it("returns all new segment keys when old matches are empty", () => {
    const newMatches = [makeMatch("root", "root"), makeMatch("home", "root/home")];
    const result = diffSegments([], newMatches);
    assert.deepEqual(result, ["root", "root/home"]);
  });

  it("returns empty array when matches are identical", () => {
    const matches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
    const result = diffSegments(matches, matches);
    assert.deepEqual(result, []);
  });

  it("returns all new keys when routes diverge at root", () => {
    const oldMatches = [makeMatch("root-a", "root-a"), makeMatch("page-a", "root-a/page-a")];
    const newMatches = [makeMatch("root-b", "root-b"), makeMatch("page-b", "root-b/page-b")];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, ["root-b", "root-b/page-b"]);
  });

  it("returns only changed keys when routes diverge in the middle", () => {
    const oldMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("overview", "root/dashboard/overview"),
    ];
    const newMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("settings", "root/dashboard/settings"),
    ];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, ["root/dashboard/settings"]);
  });

  it("detects divergence when params differ but route IDs match", () => {
    const oldMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "1" })];
    const newMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "2" })];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, ["root/post"]);
  });

  it("handles old matches longer than new", () => {
    const oldMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("settings", "root/dashboard/settings"),
    ];
    const newMatches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, ["root/about"]);
  });

  it("handles new matches longer than old", () => {
    const oldMatches = [makeMatch("root", "root")];
    const newMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("settings", "root/dashboard/settings"),
    ];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, ["root/dashboard", "root/dashboard/settings"]);
  });

  it("returns empty array for identical single-element matches", () => {
    const oldMatches = [makeMatch("root", "root")];
    const newMatches = [makeMatch("root", "root")];
    const result = diffSegments(oldMatches, newMatches);
    assert.deepEqual(result, []);
  });
});
