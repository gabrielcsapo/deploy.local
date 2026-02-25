import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
    assert.equal(matches.length, 2);
    assert.equal(matches[0].route.id, "root");
    assert.equal(matches[1].route.id, "home");
  });

  it("matches static route", () => {
    const matches = matchRoutes(routes, "/about");
    assert.equal(matches.length, 2);
    assert.equal(matches[1].route.id, "about");
  });

  it("matches dynamic route with param", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const detail = matches.find((m) => m.route.id === "detail");
    assert.ok(detail);
    assert.equal(detail.params.name, "my-app");
  });

  it("index route inherits params from parent dynamic route", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const overview = matches.find((m) => m.route.id === "detail-overview");
    assert.ok(overview, "detail-overview match should exist");
    assert.equal(
      overview.params.name,
      "my-app",
      "index route should inherit :name param from parent",
    );
  });

  it("deepest match has correct params for useParams()", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app");
    const deepest = matches[matches.length - 1];
    assert.equal(deepest.route.id, "detail-overview");
    assert.equal(
      deepest.params.name,
      "my-app",
      "deepest match params should include parent dynamic param",
    );
  });

  it("child static route inherits params from parent dynamic route", () => {
    const matches = matchRoutes(routes, "/dashboard/my-app/settings");
    const settings = matches.find((m) => m.route.id === "detail-settings");
    assert.ok(settings);
    assert.equal(settings.params.name, "my-app");
  });

  it("dashboard index route has empty params", () => {
    const matches = matchRoutes(routes, "/dashboard");
    const dashIndex = matches.find((m) => m.route.id === "dashboard-index");
    assert.ok(dashIndex);
    assert.deepEqual(dashIndex.params, {});
  });

  it("decodes URI-encoded dynamic segments", () => {
    const matches = matchRoutes(routes, "/dashboard/my%20app");
    const detail = matches.find((m) => m.route.id === "detail");
    assert.ok(detail);
    assert.equal(detail.params.name, "my app");
  });

  it("returns empty matches for unmatched paths", () => {
    const matches = matchRoutes(routes, "/nonexistent/path");
    assert.equal(matches.length, 0);
  });
});
