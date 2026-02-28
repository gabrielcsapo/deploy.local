import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
      assert.deepStrictEqual(getScrollPositions(), {});
    });

    it("returns parsed positions from sessionStorage", () => {
      store.set(STORAGE_KEY, JSON.stringify({ abc: 100, def: 200 }));
      assert.deepStrictEqual(getScrollPositions(), { abc: 100, def: 200 });
    });

    it("returns empty object on malformed JSON", () => {
      store.set(STORAGE_KEY, "not-json");
      assert.deepStrictEqual(getScrollPositions(), {});
    });
  });

  // --- saveScrollPosition ---

  describe("saveScrollPosition", () => {
    it("saves a scroll position for a key", () => {
      saveScrollPosition("page1", 400);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      assert.strictEqual(stored.page1, 400);
    });

    it("updates an existing key", () => {
      saveScrollPosition("page1", 400);
      saveScrollPosition("page1", 0);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      assert.strictEqual(stored.page1, 0);
    });

    it("preserves other keys when saving", () => {
      saveScrollPosition("a", 100);
      saveScrollPosition("b", 200);
      const stored = JSON.parse(store.get(STORAGE_KEY)!);
      assert.deepStrictEqual(stored, { a: 100, b: 200 });
    });

    it("prunes oldest entries when exceeding MAX_SCROLL_POSITIONS", () => {
      // Fill to the limit
      for (let i = 0; i < MAX_SCROLL_POSITIONS; i++) {
        saveScrollPosition(`key${i}`, i);
      }
      let stored = JSON.parse(store.get(STORAGE_KEY)!);
      assert.strictEqual(Object.keys(stored).length, MAX_SCROLL_POSITIONS);

      // Add one more — the oldest (key0) should be pruned
      saveScrollPosition("overflow", 999);
      stored = JSON.parse(store.get(STORAGE_KEY)!);
      assert.strictEqual(Object.keys(stored).length, MAX_SCROLL_POSITIONS);
      assert.strictEqual(stored.overflow, 999);
      assert.strictEqual(stored.key0, undefined);
      // key1 should still exist
      assert.strictEqual(stored.key1, 1);
    });

    it("handles sessionStorage being unavailable gracefully", () => {
      // Simulate sessionStorage throwing (e.g. quota exceeded)
      const origSet = store.set.bind(store);
      store.set = () => {
        throw new Error("quota exceeded");
      };
      // Should not throw
      assert.doesNotThrow(() => saveScrollPosition("x", 100));
      store.set = origSet;
    });
  });
});
