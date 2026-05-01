import { describe, it, expect } from "vitest";
import {
  createDevManifests,
  legacyBuildDevClientManifest,
  legacyBuildDevServerActionsManifest,
} from "./dev-manifest.js";
import { getModuleId } from "../build/plugin-use-client.js";

const APP_ROOT = "/Users/dev/my-app";

function makeClientModulePaths(n: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    paths.push(`${APP_ROOT}/app/components/widget-${i}.client.tsx`);
  }
  return paths;
}

function makeServerActionPaths(n: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    paths.push(`${APP_ROOT}/app/actions/handler-${i}.ts`);
  }
  return paths;
}

describe("createDevManifests — correctness", () => {
  it("client manifest returns the same shape as the legacy linear-scan implementation", () => {
    const paths = makeClientModulePaths(10);
    const set = new Set(paths);

    const legacy = legacyBuildDevClientManifest(set, APP_ROOT);
    const { clientManifest } = createDevManifests({
      clientModules: set,
      serverModules: new Set(),
      appRoot: APP_ROOT,
    });

    for (const path of paths) {
      const id = getModuleId(path);
      expect(clientManifest[id]).toEqual(legacy[id]);
    }

    // Misses return undefined
    expect(clientManifest["does/not/exist"]).toBeUndefined();
    expect(legacy["does/not/exist"]).toBeUndefined();
  });

  it("server-actions manifest returns the same shape as the legacy implementation", () => {
    const paths = makeServerActionPaths(10);
    const set = new Set(paths);

    const legacy = legacyBuildDevServerActionsManifest(set);
    const { serverActionsManifest } = createDevManifests({
      clientModules: new Set(),
      serverModules: set,
      appRoot: APP_ROOT,
    });

    for (const path of paths) {
      const id = getModuleId(path);
      const key = `${id}#myExport`;
      expect(serverActionsManifest[key]).toEqual(legacy[key]);
    }
    expect(serverActionsManifest["does/not/exist#x"]).toBeUndefined();
  });

  it("client manifest reflects modules added after creation", () => {
    const set = new Set<string>();
    const { clientManifest } = createDevManifests({
      clientModules: set,
      serverModules: new Set(),
      appRoot: APP_ROOT,
    });

    const path = `${APP_ROOT}/app/components/lazy.client.tsx`;
    const id = getModuleId(path);
    expect(clientManifest[id]).toBeUndefined();

    set.add(path);
    expect(clientManifest[id]).toBeDefined();
    expect(clientManifest[id].chunks).toBeInstanceOf(Array);
  });

  it("server-actions manifest reflects modules added after creation", () => {
    const set = new Set<string>();
    const { serverActionsManifest } = createDevManifests({
      clientModules: new Set(),
      serverModules: set,
      appRoot: APP_ROOT,
    });

    const path = `${APP_ROOT}/app/actions/lazy.ts`;
    const id = getModuleId(path);
    expect(serverActionsManifest[`${id}#go`]).toBeUndefined();

    set.add(path);
    expect(serverActionsManifest[`${id}#go`]).toEqual({
      id: path,
      name: "go",
      chunks: [],
    });
  });
});

describe("createDevManifests — perf vs legacy linear scan", () => {
  // Ratio gates are loose to remain stable across machines and Node versions —
  // the assertion is "the new path is at least as fast", not a fixed multiplier.
  const M = 200; // realistic-ish: medium app with ~200 client components
  const LOOKUPS = 5000; // simulates many references over many renders

  it("client manifest: Map lookup is faster than linear scan", () => {
    const paths = makeClientModulePaths(M);
    const ids = paths.map((p) => getModuleId(p));
    const set = new Set(paths);

    const legacy = legacyBuildDevClientManifest(set, APP_ROOT);
    const { clientManifest } = createDevManifests({
      clientModules: set,
      serverModules: new Set(),
      appRoot: APP_ROOT,
    });

    // Warm up
    for (let i = 0; i < 50; i++) {
      void legacy[ids[i % M]];
      void clientManifest[ids[i % M]];
    }

    const t0 = performance.now();
    for (let i = 0; i < LOOKUPS; i++) void legacy[ids[i % M]];
    const tLegacy = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < LOOKUPS; i++) void clientManifest[ids[i % M]];
    const tNew = performance.now() - t1;

    const speedup = tLegacy / tNew;
    // eslint-disable-next-line no-console
    console.log(
      `client manifest: M=${M} lookups=${LOOKUPS}  legacy=${tLegacy.toFixed(2)}ms  new=${tNew.toFixed(2)}ms  speedup=${speedup.toFixed(1)}x`,
    );

    // Sanity: should be at least 2x at this scale; in practice it's much higher.
    expect(speedup).toBeGreaterThan(2);
  });

  it("server-actions manifest: Map lookup is faster than linear scan", () => {
    const paths = makeServerActionPaths(M);
    const ids = paths.map((p) => getModuleId(p));
    const set = new Set(paths);

    const legacy = legacyBuildDevServerActionsManifest(set);
    const { serverActionsManifest } = createDevManifests({
      clientModules: new Set(),
      serverModules: set,
      appRoot: APP_ROOT,
    });

    // Warm up
    for (let i = 0; i < 50; i++) {
      void legacy[`${ids[i % M]}#x`];
      void serverActionsManifest[`${ids[i % M]}#x`];
    }

    const t0 = performance.now();
    for (let i = 0; i < LOOKUPS; i++) void legacy[`${ids[i % M]}#x`];
    const tLegacy = performance.now() - t0;

    const t1 = performance.now();
    for (let i = 0; i < LOOKUPS; i++) void serverActionsManifest[`${ids[i % M]}#x`];
    const tNew = performance.now() - t1;

    const speedup = tLegacy / tNew;
    // eslint-disable-next-line no-console
    console.log(
      `server actions:  M=${M} lookups=${LOOKUPS}  legacy=${tLegacy.toFixed(2)}ms  new=${tNew.toFixed(2)}ms  speedup=${speedup.toFixed(1)}x`,
    );

    expect(speedup).toBeGreaterThan(2);
  });
});
