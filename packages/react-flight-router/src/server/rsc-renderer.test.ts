import { describe, it, expect, vi } from "vitest";
import { renderRSC } from "./rsc-renderer.js";
import type { RouteConfig } from "../router/types.js";

const noop = () => Promise.resolve({ default: () => null });

function mockRenderToReadableStream(model: unknown) {
  const encoded = new TextEncoder().encode(JSON.stringify(model));
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

describe("rsc-renderer: boundary module loading", () => {
  it("loads loading and error boundary modules in parallel", async () => {
    const loadOrder: string[] = [];

    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        loading: async () => {
          loadOrder.push("loading-start");
          // Simulate async delay
          await new Promise((r) => setTimeout(r, 10));
          loadOrder.push("loading-end");
          return { default: () => null };
        },
        error: async () => {
          loadOrder.push("error-start");
          await new Promise((r) => setTimeout(r, 10));
          loadOrder.push("error-end");
          return { default: () => null };
        },
        children: [{ id: "home", index: true, component: noop }],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async (id: string) => ({ default: () => null }),
    });

    expect(result.status).toBe(200);

    // Both should start before either finishes (parallel loading)
    const loadingStartIdx = loadOrder.indexOf("loading-start");
    const errorStartIdx = loadOrder.indexOf("error-start");
    const loadingEndIdx = loadOrder.indexOf("loading-end");
    const errorEndIdx = loadOrder.indexOf("error-end");

    // Both started before either ended
    expect(loadingStartIdx).toBeLessThan(loadingEndIdx);
    expect(errorStartIdx).toBeLessThan(errorEndIdx);
    // Both started before either ended — proves parallelism
    expect(Math.max(loadingStartIdx, errorStartIdx)).toBeLessThan(
      Math.min(loadingEndIdx, errorEndIdx),
    );
  });

  it("loads boundary modules across multiple matches in parallel", async () => {
    const startTimes: Record<string, number> = {};
    const endTimes: Record<string, number> = {};

    const makeDelayedBoundary = (name: string) => async () => {
      startTimes[name] = performance.now();
      await new Promise((r) => setTimeout(r, 20));
      endTimes[name] = performance.now();
      return { default: () => null };
    };

    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: noop,
        loading: makeDelayedBoundary("root-loading"),
        children: [
          {
            id: "dashboard",
            path: "dashboard",
            component: noop,
            loading: makeDelayedBoundary("dashboard-loading"),
            children: [{ id: "dash-index", index: true, component: noop }],
          },
        ],
      },
    ];

    await renderRSC({
      url: new URL("http://localhost/dashboard"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    // Both boundary loads should have started before either finished
    expect(startTimes["root-loading"]).toBeDefined();
    expect(startTimes["dashboard-loading"]).toBeDefined();
    expect(Math.max(startTimes["root-loading"], startTimes["dashboard-loading"])).toBeLessThan(
      Math.min(endTimes["root-loading"], endTimes["dashboard-loading"]),
    );
  });

  it("handles boundary module load failure gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: noop,
        loading: async () => {
          throw new Error("Failed to load");
        },
        children: [{ id: "home", index: true, component: noop }],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    expect(result.status).toBe(200);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load loading component for "root"'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });
});
