import { describe, it, expect } from "vitest";
import { matchRoutes } from "./route-matcher.js";
import type { RouteConfig } from "./types.js";

const noop = () => Promise.resolve({ default: () => null });

describe("matchRoutes", () => {
  const routes: RouteConfig[] = [
    {
      id: "root",
      path: "",
      component: noop,
      children: [
        { id: "home", index: true, component: noop },
        { id: "about", path: "about", component: noop },
        {
          id: "dashboard",
          path: "dashboard",
          component: noop,
          children: [
            { id: "dashboard-index", index: true, component: noop },
            {
              id: "detail",
              path: ":name",
              component: noop,
              children: [
                { id: "detail-overview", index: true, component: noop },
                { id: "detail-settings", path: "settings", component: noop },
              ],
            },
          ],
        },
      ],
    },
  ];

  it("matches root index", () => {
    const matches = matchRoutes(routes, "/");
    expect(matches.length).toBe(2);
    expect(matches[0].route.id).toBe("root");
    expect(matches[1].route.id).toBe("home");
  });

  it("matches static route", () => {
    const matches = matchRoutes(routes, "/about");
    expect(matches.length).toBe(2);
    expect(matches[1].route.id).toBe("about");
  });

  it("matches dynamic route with param", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const detail = matches.find((m) => m.route.id === "detail");
    expect(detail).toBeDefined();
    expect(detail!.params.name).toBe("my-app");
  });

  it("index route inherits params from parent dynamic route", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const overview = matches.find((m) => m.route.id === "detail-overview");
    expect(overview).toBeDefined();
    expect(overview!.params.name).toBe("my-app");
  });

  it("deepest match has correct params for useParams()", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const deepest = matches[matches.length - 1];
    expect(deepest.route.id).toBe("detail-overview");
    expect(deepest.params.name).toBe("my-app");
  });

  it("child static route inherits params from parent dynamic route", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app/settings");
    const settings = matches.find((m) => m.route.id === "detail-settings");
    expect(settings).toBeDefined();
    expect(settings!.params.name).toBe("my-app");
  });

  it("dashboard index route has empty params", () => {
    const matches = matchRoutes(routes, "/dashboard");
    const dashIndex = matches.find((m) => m.route.id === "dashboard-index");
    expect(dashIndex).toBeDefined();
    expect(dashIndex!.params).toEqual({});
  });

  it("decodes URI-encoded dynamic segments", () => {
    const matches = matchRoutes(routes, "/dashboard/my%20app");
    const detail = matches.find((m) => m.route.id === "detail");
    expect(detail).toBeDefined();
    expect(detail!.params.name).toBe("my app");
  });

  it("returns empty matches for unmatched paths", () => {
    const matches = matchRoutes(routes, "/nonexistent/path");
    expect(matches.length).toBe(0);
  });
});
