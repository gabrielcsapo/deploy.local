import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderRSC, clearRouteMatchCache, nonSlotSearchKey } from "./rsc-renderer.js";
import { redirect } from "./redirect.js";
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

describe("rsc-renderer: redirect", () => {
  beforeEach(() => {
    clearRouteMatchCache();
  });

  it("returns redirect result when a component calls redirect()", async () => {
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        children: [
          {
            id: "protected",
            path: "protected",
            component: () =>
              Promise.resolve({
                default: async () => {
                  redirect("/login");
                },
              }),
          },
        ],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/protected"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    expect(result.redirect).toEqual({ url: "/login", status: 302 });
    expect(result.status).toBe(302);
    expect(result.params).toEqual({});
  });

  it("returns 301 when redirect is called with 301 status", async () => {
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        children: [
          {
            id: "moved",
            path: "moved",
            component: () =>
              Promise.resolve({
                default: () => {
                  redirect("/new-location", 301);
                },
              }),
          },
        ],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/moved"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    expect(result.redirect).toEqual({ url: "/new-location", status: 301 });
    expect(result.status).toBe(301);
  });

  it("redirect from root layout produces redirect result regardless of child routes", async () => {
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () =>
          Promise.resolve({
            default: () => {
              redirect("/maintenance");
            },
          }),
        children: [
          {
            id: "home",
            index: true,
            component: () => Promise.resolve({ default: () => null }),
          },
        ],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    // Redirect from any route in the tree should produce a redirect result.
    // Component loaders run in parallel, so child loading is not necessarily
    // skipped — only the redirect result matters.
    expect(result.redirect?.url).toBe("/maintenance");
    expect(result.redirect?.status).toBe(302);
  });

  it("redirect includes the RSC payload stream encoding the redirect", async () => {
    const captured: unknown[] = [];
    const capturingRenderer = (model: unknown) => {
      captured.push(model);
      return mockRenderToReadableStream(model);
    };

    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        children: [
          {
            id: "page",
            path: "page",
            component: () =>
              Promise.resolve({
                default: () => {
                  redirect("/elsewhere");
                },
              }),
          },
        ],
      },
    ];

    await renderRSC({
      url: new URL("http://localhost/page"),
      routes,
      clientManifest: {},
      renderToReadableStream: capturingRenderer as any,
      loadModule: async () => ({ default: () => null }),
    });

    // The redirect payload passed to renderToReadableStream should carry redirect info
    expect(captured).toHaveLength(1);
    const payload = captured[0] as any;
    expect(payload.redirect).toEqual({ url: "/elsewhere", status: 302 });
    expect(payload.segments).toEqual({});
  });

  it("non-redirect errors still go through error boundary path", async () => {
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        error: () => Promise.resolve({ default: () => null }),
        children: [
          {
            id: "broken",
            path: "broken",
            component: () =>
              Promise.resolve({
                default: () => {
                  throw new Error("Something broke");
                },
              }),
          },
        ],
      },
    ];

    const result = await renderRSC({
      url: new URL("http://localhost/broken"),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

    // Error boundary handles it — no redirect
    expect(result.redirect).toBeUndefined();
    expect(result.status).toBe(500);
  });
});

describe("rsc-renderer: boundary module loading", () => {
  beforeEach(() => {
    clearRouteMatchCache();
  });
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
      loadModule: async (_id: string) => ({ default: () => null }),
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

  it("survives a boundary importer that throws synchronously", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: noop,
        // Vite's module runner throws like this once its environment is closed
        // (dev-server restart) — not a rejected promise, a synchronous throw.
        loading: (() => {
          throw new Error("Vite module runner has been closed.");
        }) as unknown as RouteConfig["loading"],
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

describe("rsc-renderer: route match cache invalidation", () => {
  beforeEach(() => {
    clearRouteMatchCache();
  });

  const makeRoutes = (marker: string, seen: string[]): RouteConfig[] => [
    {
      id: "root",
      path: "",
      component: noop,
      children: [
        {
          id: "home",
          index: true,
          component: () => {
            seen.push(marker);
            return Promise.resolve({ default: () => null });
          },
        },
      ],
    },
  ];

  it("uses the new routes array after the routes module is re-evaluated", async () => {
    const seen: string[] = [];
    const render = (routes: RouteConfig[]) =>
      renderRSC({
        url: new URL("http://localhost/"),
        routes,
        clientManifest: {},
        renderToReadableStream: mockRenderToReadableStream as any,
        loadModule: async () => ({ default: () => null }),
      });

    await render(makeRoutes("old", seen));
    // A dev HMR update / server restart hands us a freshly-evaluated routes
    // array. Serving cached matches here would call the *previous* module's
    // import closures, which are bound to a now-closed Vite module runner.
    await render(makeRoutes("new", seen));

    expect(seen).toEqual(["old", "new"]);
  });

  it("keeps serving cached matches while the routes array identity is unchanged", async () => {
    const seen: string[] = [];
    const routes = makeRoutes("first", seen);
    const render = () =>
      renderRSC({
        url: new URL("http://localhost/"),
        routes,
        clientManifest: {},
        renderToReadableStream: mockRenderToReadableStream as any,
        loadModule: async () => ({ default: () => null }),
      });

    await render();
    // Same array identity, so the cached RouteMatch — which still points at the
    // original child route object — is reused and this replacement is never
    // matched. Proves the identity check didn't turn the cache into a no-op.
    routes[0].children![0] = {
      id: "home",
      index: true,
      component: () => {
        seen.push("swapped");
        return Promise.resolve({ default: () => null });
      },
    };
    await render();

    expect(seen).toEqual(["first", "first"]);
  });
});

describe("nonSlotSearchKey", () => {
  it("returns empty string for no params", () => {
    expect(nonSlotSearchKey(new URLSearchParams())).toBe("");
  });

  it("returns empty string when only slot params are present", () => {
    const params = new URLSearchParams("@modal=/photo/2&@drawer=/cart");
    expect(nonSlotSearchKey(params)).toBe("");
  });

  it("treats slot-param-only differences as no change", () => {
    const before = new URLSearchParams("@modal=/photo/2");
    const after = new URLSearchParams("");
    expect(nonSlotSearchKey(before)).toBe(nonSlotSearchKey(after));
  });

  it("treats adding a slot param as no change", () => {
    const before = new URLSearchParams("");
    const after = new URLSearchParams("@modal=/photo/2");
    expect(nonSlotSearchKey(before)).toBe(nonSlotSearchKey(after));
  });

  it("treats real param differences as a change", () => {
    const before = new URLSearchParams("value=A");
    const after = new URLSearchParams("value=B");
    expect(nonSlotSearchKey(before)).not.toBe(nonSlotSearchKey(after));
  });

  it("isolates a real param change even when slot params also change", () => {
    const before = new URLSearchParams("@modal=/photo/2&value=A");
    const after = new URLSearchParams("value=B");
    expect(nonSlotSearchKey(before)).not.toBe(nonSlotSearchKey(after));
  });

  it("ignores ordering of params", () => {
    const a = new URLSearchParams("a=1&b=2");
    const b = new URLSearchParams("b=2&a=1");
    expect(nonSlotSearchKey(a)).toBe(nonSlotSearchKey(b));
  });
});

describe("searchParams prop", () => {
  beforeEach(() => {
    clearRouteMatchCache();
  });

  const render = (url: string, routes: RouteConfig[]) =>
    renderRSC({
      url: new URL(url),
      routes,
      clientManifest: {},
      renderToReadableStream: mockRenderToReadableStream as any,
      loadModule: async () => ({ default: () => null }),
    });

  it("passes non-slot search params to route components", async () => {
    const received: Record<string, unknown>[] = [];
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () =>
          Promise.resolve({
            default: (props: any) => {
              received.push(props);
              return null;
            },
          }),
        children: [
          {
            id: "search",
            path: "search",
            component: () =>
              Promise.resolve({
                default: (props: any) => {
                  received.push(props);
                  return null;
                },
              }),
          },
        ],
      },
    ];

    await render("http://localhost/search?q=test&page=2", routes);

    // Layout and page both receive the same searchParams object.
    expect(received).toHaveLength(2);
    for (const props of received) {
      expect(props.searchParams).toEqual({ q: "test", page: "2" });
    }
  });

  it("passes an empty object when the URL has no query string", async () => {
    let received: any = null;
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () =>
          Promise.resolve({
            default: (props: any) => {
              received = props;
              return null;
            },
          }),
        children: [
          {
            id: "page",
            path: "page",
            component: () =>
              Promise.resolve({
                default: (props: any) => {
                  received = props;
                  return null;
                },
              }),
          },
        ],
      },
    ];

    await render("http://localhost/page", routes);
    expect(received.searchParams).toEqual({});
  });

  it("excludes slot params, mirroring nonSlotSearchKey", async () => {
    let received: any = null;
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () =>
          Promise.resolve({
            default: (props: any) => {
              received = props;
              return null;
            },
          }),
        children: [
          {
            id: "page",
            path: "page",
            component: () =>
              Promise.resolve({
                default: (props: any) => {
                  received = props;
                  return null;
                },
              }),
          },
        ],
      },
    ];

    await render("http://localhost/page?q=test&%40modal=%2Fmovie%2F1", routes);
    expect(received.searchParams).toEqual({ q: "test" });
  });

  it("collapses duplicate keys last-wins", async () => {
    let received: any = null;
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () =>
          Promise.resolve({
            default: (props: any) => {
              received = props;
              return null;
            },
          }),
        children: [
          {
            id: "page",
            path: "page",
            component: () =>
              Promise.resolve({
                default: (props: any) => {
                  received = props;
                  return null;
                },
              }),
          },
        ],
      },
    ];

    await render("http://localhost/page?tag=a&tag=b", routes);
    expect(received.searchParams).toEqual({ tag: "b" });
  });

  it("still passes route params alongside searchParams", async () => {
    let received: any = null;
    const routes: RouteConfig[] = [
      {
        id: "root",
        path: "",
        component: () => Promise.resolve({ default: () => null }),
        children: [
          {
            id: "movie",
            path: "movie/:id",
            component: () =>
              Promise.resolve({
                default: (props: any) => {
                  received = props;
                  return null;
                },
              }),
          },
        ],
      },
    ];

    await render("http://localhost/movie/123?autoplay=1", routes);
    expect(received.params).toEqual({ id: "123" });
    expect(received.searchParams).toEqual({ autoplay: "1" });
  });
});
