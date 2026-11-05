import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const PORT = 3004;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");

let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("node", [SERVER_SCRIPT], {
    env: { ...process.env, NODE_ENV: "production", PORT: String(PORT), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout!.on("data", () => {});
  server.stderr!.on("data", () => {});

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if ((await res.json()).ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Redirect test server failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.describe("redirect()", () => {
  test.describe("SSR: initial page load", () => {
    test("302 redirect renders destination content without an extra round trip", async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/redirect-302`);

      // The destination page content should be visible
      await expect(page.getByTestId("redirect-destination-heading")).toHaveText(
        "Redirect Destination",
      );
      await expect(page.getByTestId("redirect-destination-content")).toBeVisible();
    });

    test("302 redirect updates the browser URL to the destination", async ({ page }) => {
      await page.goto(`${BASE_URL}/redirect-302`);

      // RouterProvider replaces the URL via history.replaceState on hydration
      await page.waitForURL(`${BASE_URL}/redirect-destination`);
      expect(page.url()).toBe(`${BASE_URL}/redirect-destination`);
    });

    test("301 redirect renders destination content", async ({ page }) => {
      await page.goto(`${BASE_URL}/redirect-301`);

      await expect(page.getByTestId("redirect-destination-heading")).toHaveText(
        "Redirect Destination",
      );
    });

    test("301 redirect updates the browser URL to the destination", async ({ page }) => {
      await page.goto(`${BASE_URL}/redirect-301`);

      await page.waitForURL(`${BASE_URL}/redirect-destination`);
      expect(page.url()).toBe(`${BASE_URL}/redirect-destination`);
    });

    test("direct navigation to destination works normally (no redirect loop)", async ({ page }) => {
      await page.goto(`${BASE_URL}/redirect-destination`);

      await expect(page.getByTestId("redirect-destination-heading")).toBeVisible();
      expect(page.url()).toBe(`${BASE_URL}/redirect-destination`);
    });
  });

  test.describe("client-side navigation", () => {
    test("302 redirect navigates to destination and updates URL", async ({ page }) => {
      // Start at home so we have the client router initialized
      await page.goto(`${BASE_URL}/`);
      await expect(page.locator("h1")).toHaveText("Home");

      // Click the redirect link — triggers client-side RSC navigation
      await page.getByTestId("nav-redirect-302").click();

      // Client router follows the redirect payload and navigates
      await page.waitForURL(`${BASE_URL}/redirect-destination`);
      await expect(page.getByTestId("redirect-destination-heading")).toHaveText(
        "Redirect Destination",
      );
    });

    test("301 redirect navigates to destination and updates URL", async ({ page }) => {
      await page.goto(`${BASE_URL}/`);

      await page.getByTestId("nav-redirect-301").click();

      await page.waitForURL(`${BASE_URL}/redirect-destination`);
      await expect(page.getByTestId("redirect-destination-heading")).toBeVisible();
    });

    test("redirect replaces history entry so back button skips the redirect source", async ({
      page,
    }) => {
      await page.goto(`${BASE_URL}/`);
      await page.getByTestId("nav-redirect-302").click();
      await page.waitForURL(`${BASE_URL}/redirect-destination`);

      // The redirect used replace:true, so going back should return to Home, not /redirect-302
      await page.goBack();
      await page.waitForURL(`${BASE_URL}/`);
      await expect(page.locator("h1")).toHaveText("Home");
    });
  });

  test.describe("RSC endpoint: raw redirect payload", () => {
    test("RSC response for redirect source contains redirect payload", async () => {
      const res = await fetch(`${BASE_URL}/__rsc?url=${encodeURIComponent("/redirect-302")}`);
      expect(res.ok).toBe(true);

      const text = await res.text();
      // The RSC payload should encode a redirect object, not route segments
      expect(text).toContain("/redirect-destination");
      expect(text).toContain('"redirect"');
    });
  });
});
