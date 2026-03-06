import { describe, it, expect, beforeEach } from "vitest";
import {
  getScrollPositions,
  saveScrollPosition,
  STORAGE_KEY,
  MAX_SCROLL_POSITIONS,
} from "./scroll-restoration.js";

// ---------------------------------------------------------------------------
// Minimal sessionStorage mock for Node.js
// ---------------------------------------------------------------------------

const store = new Map<string, string>();

Object.defineProperty(globalThis, "sessionStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  },
  configurable: true,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scroll-restoration storage", () => {
  beforeEach(() => {
    store.clear();
  });

  // --- getScrollPositions ---

  describe("getScrollPositions", () => {
    it("returns empty object when nothing is stored", () => {
      expect(getScrollPositions()).toEqual({});
    });

    it("returns parsed positions from sessionStorage", () => {
      store.set(STORAGE_KEY, JSON.stringify({ abc: 100, def: 200 }));
      expect(getScrollPositions()).toEqual({ abc: 100, def: 200 });
    });

    it("returns empty object on malformed JSON", () => {
      store.set(STORAGE_KEY, "not-json");
      expect(getScrollPositions()).toEqual({});
    });
  });

  // --- saveScrollPosition ---

  describe("saveScrollPosition", () => {
    it("saves a scroll position for a key", () => {
      saveScrollPosition("page1", 400);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      expect(stored.page1).toBe(400);
    });

    it("updates an existing key", () => {
      saveScrollPosition("page1", 400);
      saveScrollPosition("page1", 0);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      expect(stored.page1).toBe(0);
    });

    it("preserves other keys when saving", () => {
      saveScrollPosition("a", 100);
      saveScrollPosition("b", 200);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      expect(stored).toEqual({ a: 100, b: 200 });
    });

    it("prunes oldest entries when exceeding MAX_SCROLL_POSITIONS", () => {
      // Fill to the limit
      for (let i = 0; i < MAX_SCROLL_POSITIONS; i++) {
        saveScrollPosition(`key${i}`, i);
      }
      let stored = JSON.parse(store.get(STORAGE_KEY)!);
      expect(Object.keys(stored).length).toBe(MAX_SCROLL_POSITIONS);

      // Add one more — the oldest (key0) should be pruned
      saveScrollPosition("overflow", 999);
      stored = JSON.parse(store.get(STORAGE_KEY)!);
      expect(Object.keys(stored).length).toBe(MAX_SCROLL_POSITIONS);
      expect(stored.overflow).toBe(999);
      expect(stored.key0).toBeUndefined();
      // key1 should still exist
      expect(stored.key1).toBe(1);
    });

    it("handles sessionStorage being unavailable gracefully", () => {
      // Simulate sessionStorage throwing (e.g. quota exceeded)
      const origSet = store.set.bind(store);
      store.set = () => {
        throw new Error("quota exceeded");
      };
      // Should not throw
      expect(() => saveScrollPosition("x", 100)).not.toThrow();
      store.set = origSet;
    });
  });
});
