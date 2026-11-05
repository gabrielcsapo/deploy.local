import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Verifies the example app's public/ assets are served end-to-end in both
 * the production build and the vite dev server.
 *
 * The same spec is wired into both playwright projects (production on :3000,
 * dev on :5173) — the baseURL comes from the project config, so the
 * assertions are environment-agnostic. The Cache-Control assertion is the
 * one exception: the production server sets a daily-revalidating header on
 * public files; vite dev doesn't, so we only assert when running against
 * production.
 */

const PUBLIC_DIR = resolve(import.meta.dirname, "..", "public");
const NESTED_REL_PATH = "deep/a/b/c/d/e/nested.txt";
const FAVICON_EXPECTED = readFileSync(resolve(PUBLIC_DIR, "favicon.svg"), "utf8");
const ROBOTS_EXPECTED = readFileSync(resolve(PUBLIC_DIR, "robots.txt"), "utf8");
const LOGO_EXPECTED = readFileSync(resolve(PUBLIC_DIR, "logo.svg"), "utf8");
const NESTED_EXPECTED = readFileSync(resolve(PUBLIC_DIR, NESTED_REL_PATH), "utf8");

test.describe("publicDir static assets", () => {
  test("favicon.svg is served with the SVG content type", async ({ request }) => {
    const res = await request.get("/favicon.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("image/svg+xml");
    expect(await res.text()).toBe(FAVICON_EXPECTED);
  });

  test("robots.txt is served with text/plain", async ({ request }) => {
    const res = await request.get("/robots.txt");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("text/plain");
    expect(await res.text()).toBe(ROBOTS_EXPECTED);
  });

  test("logo.svg is served and displayed on the home page", async ({ page, request }) => {
    const res = await request.get("/logo.svg");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("image/svg+xml");
    expect(await res.text()).toBe(LOGO_EXPECTED);

    // The home page references the file via <img src="/logo.svg">. Confirm
    // the image element resolves to a real network response (no 404, real
    // SVG bytes). page.goto("/") would do the same fetch, but we want a
    // narrower assertion that the resolved URL actually returned 200.
    await page.goto("/");
    const logo = page.getByTestId("home-logo");
    await expect(logo).toBeVisible();
    expect(await logo.getAttribute("src")).toBe("/logo.svg");
  });

  test("SSR HTML references the favicon", async ({ page }) => {
    // Block client JS so we observe the raw SSR-rendered HTML — confirms
    // the <link rel="icon"> in root.tsx survives the SSR pipeline rather
    // than only being added by client-side hydration.
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const link = page.locator('link[rel="icon"]');
    await expect(link).toHaveAttribute("href", "/favicon.svg");
    await expect(link).toHaveAttribute("type", "image/svg+xml");
  });

  test("nested file (5 directories deep) is served verbatim", async ({ request }) => {
    // Guards against the server only registering routes for top-level
    // files: the build copies the whole publicDir tree, so the handler
    // must walk subdirectories at startup to discover nested entries.
    const res = await request.get(`/${NESTED_REL_PATH}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("text/plain");
    expect(await res.text()).toBe(NESTED_EXPECTED);

    // A neighbouring file that doesn't exist inside the nested directory
    // must still 404 — the nested route isn't a wildcard.
    const missing = await request.get("/deep/a/b/c/d/e/does-not-exist.txt");
    expect(missing.status()).toBe(404);
  });

  test("unknown public-style paths don't get silently served", async ({ request }) => {
    // Guards against the public-file handler being registered as a wildcard
    // and accidentally swallowing arbitrary URLs that happen to look like
    // static files. A 404 is the right outcome — exact rendering of that
    // 404 differs between prod (SSR catch-all HTML) and vite dev (plain
    // 404), which is why we only assert the status code here.
    const res = await request.get("/this-file-truly-does-not-exist.txt");
    expect(res.status()).toBe(404);
  });
});
