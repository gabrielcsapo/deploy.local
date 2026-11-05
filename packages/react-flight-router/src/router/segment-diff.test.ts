import { describe, it, expect } from "vitest";
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
    expect(result).toEqual(["root", "root/home"]);
  });

  it("returns empty array when matches are identical", () => {
    const matches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
    const result = diffSegments(matches, matches);
    expect(result).toEqual([]);
  });

  it("returns all new keys when routes diverge at root", () => {
    const oldMatches = [makeMatch("root-a", "root-a"), makeMatch("page-a", "root-a/page-a")];
    const newMatches = [makeMatch("root-b", "root-b"), makeMatch("page-b", "root-b/page-b")];
    const result = diffSegments(oldMatches, newMatches);
    expect(result).toEqual(["root-b", "root-b/page-b"]);
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
    expect(result).toEqual(["root/dashboard/settings"]);
  });

  it("detects divergence when params differ but route IDs match", () => {
    const oldMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "1" })];
    const newMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "2" })];
    const result = diffSegments(oldMatches, newMatches);
    expect(result).toEqual(["root/post"]);
  });

  it("handles old matches longer than new", () => {
    const oldMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("settings", "root/dashboard/settings"),
    ];
    const newMatches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
    const result = diffSegments(oldMatches, newMatches);
    expect(result).toEqual(["root/about"]);
  });

  it("handles new matches longer than old", () => {
    const oldMatches = [makeMatch("root", "root")];
    const newMatches = [
      makeMatch("root", "root"),
      makeMatch("dashboard", "root/dashboard"),
      makeMatch("settings", "root/dashboard/settings"),
    ];
    const result = diffSegments(oldMatches, newMatches);
    expect(result).toEqual(["root/dashboard", "root/dashboard/settings"]);
  });

  it("returns empty array for identical single-element matches", () => {
    const oldMatches = [makeMatch("root", "root")];
    const newMatches = [makeMatch("root", "root")];
    const result = diffSegments(oldMatches, newMatches);
    expect(result).toEqual([]);
  });

  describe("searchChanged option", () => {
    it("returns the full matched chain when only search params changed", () => {
      // Pathname-equivalent matches (same routes, same params) — the
      // default diff would return [] meaning "render nothing." When
      // searchChanged is true we force a full re-render so any ancestor
      // that read the URL via getRequest() picks up the new value.
      const matches = [
        makeMatch("root", "root"),
        makeMatch("library", "root/library"),
        makeMatch("metadata", "root/library/metadata"),
      ];
      const result = diffSegments(matches, matches, { searchChanged: true });
      expect(result).toEqual(["root", "root/library", "root/library/metadata"]);
    });

    it("preserves existing behavior when searchChanged is false", () => {
      const matches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
      const result = diffSegments(matches, matches, { searchChanged: false });
      expect(result).toEqual([]);
    });

    it("preserves existing behavior when options is omitted", () => {
      const matches = [makeMatch("root", "root"), makeMatch("about", "root/about")];
      const result = diffSegments(matches, matches);
      expect(result).toEqual([]);
    });

    it("forces the full chain even when params also differ", () => {
      // The searchChanged path takes precedence — search change is
      // conservatively assumed to affect every segment in the chain, not
      // just the divergence point.
      const oldMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "1" })];
      const newMatches = [makeMatch("root", "root"), makeMatch("post", "root/post", { id: "2" })];
      const result = diffSegments(oldMatches, newMatches, { searchChanged: true });
      expect(result).toEqual(["root", "root/post"]);
    });
  });
});
