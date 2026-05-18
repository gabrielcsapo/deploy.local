import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

/**
 * Regression test for the search-only-navigation bug.
 *
 * Before the diffSegments fix, `router.navigate("/x?a=2")` from `/x?a=1`
 * computed zero changed segments (because pathname + route params matched)
 * and returned an empty partial RSC payload. The page kept showing stale
 * data even though the URL changed.
 *
 * This spec exercises the fix in BOTH the production build (the same path
 * the other e2e specs cover) and the vite dev server, so the dev-mode HMR
 * pipeline doesn't silently regress.
 */

const PROD_PORT = 3006;
const DEV_PORT = 3007;

const PROD_SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");
const E2E_PACKAGE_DIR = resolve(import.meta.dirname, "..");
const VITE_BIN = resolve(E2E_PACKAGE_DIR, "node_modules/.bin/vite");

async function waitForServer(
  baseUrl: string,
  timeoutMs: number,
  options: { probe?: "health" | "root" } = {},
): Promise<void> {
  const probe = options.probe ?? "health";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (probe === "health") {
        const res = await fetch(`${baseUrl}/api/health`);
        if (res.ok && (await res.json()).ok) return;
      } else {
        // Vite dev doesn't ship the production /api/health endpoint; probe
        // the page we're about to test instead. A 200 means vite has
        // compiled the RSC entry and is serving routes.
        const res = await fetch(`${baseUrl}/search-params`);
        if (res.ok) return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${baseUrl} failed to start within ${timeoutMs}ms`);
}

/**
 * Core assertions, parameterized by base URL so we can point them at either
 * the production server or the vite dev server.
 */
async function assertSearchParamNavigationUpdatesPage(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/search-params?value=A`);

  await expect(page.getByTestId("search-params-page")).toBeVisible();
  await expect(page.getByTestId("search-params-value")).toHaveText("A");

  const renderIdA = await page.getByTestId("search-params-render-id").textContent();
  expect(renderIdA).toBeTruthy();

  // Soft-navigate to ?value=B. Before the fix this updated the URL but left
  // the rendered value as "A" — the bug we're guarding against.
  await page.getByTestId("link-value-b").click();
  await expect(page).toHaveURL(`${baseUrl}/search-params?value=B`);
  await expect(page.getByTestId("search-params-value")).toHaveText("B");

  const renderIdB = await page.getByTestId("search-params-render-id").textContent();
  // The server-render id is regenerated each render, so a successful
  // re-render produces a different string. This catches the failure mode
  // where the URL changes but the server returned an empty patch and the
  // client kept the old DOM.
  expect(renderIdB).toBeTruthy();
  expect(renderIdB).not.toEqual(renderIdA);

  await page.getByTestId("link-value-c").click();
  await expect(page).toHaveURL(`${baseUrl}/search-params?value=C`);
  await expect(page.getByTestId("search-params-value")).toHaveText("C");

  const renderIdC = await page.getByTestId("search-params-render-id").textContent();
  expect(renderIdC).not.toEqual(renderIdB);

  // Navigate back to A and confirm the round-trip also works.
  await page.getByTestId("link-value-a").click();
  await expect(page).toHaveURL(`${baseUrl}/search-params?value=A`);
  await expect(page.getByTestId("search-params-value")).toHaveText("A");
}

test.describe("Search-only navigation — production server", () => {
  const BASE_URL = `http://localhost:${PROD_PORT}`;
  let server: ChildProcess;

  test.beforeAll(async () => {
    server = spawn("node", [PROD_SERVER_SCRIPT], {
      env: { ...process.env, NODE_ENV: "production", PORT: String(PROD_PORT), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", () => {});
    server.stderr!.on("data", () => {});
    await waitForServer(BASE_URL, 15_000);
  });

  test.afterAll(async () => {
    server?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  });

  test("router.navigate between ?value=A/B/C re-renders the page", async ({ page }) => {
    await assertSearchParamNavigationUpdatesPage(page, BASE_URL);
  });
});

test.describe("Search-only navigation — vite dev server", () => {
  const BASE_URL = `http://localhost:${DEV_PORT}`;
  let server: ChildProcess;

  test.beforeAll(async () => {
    // Invoke the local vite binary directly rather than going through `pnpm
    // exec` — pnpm sometimes hangs in spawned non-TTY contexts waiting on
    // store locks, which manifested as a "server failed to start" timeout
    // before this fix.
    server = spawn(VITE_BIN, ["--port", String(DEV_PORT), "--strictPort"], {
      cwd: E2E_PACKAGE_DIR,
      env: { ...process.env, NODE_ENV: "development", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", () => {});
    server.stderr!.on("data", () => {});
    // Vite dev cold start is slower than the production server — give it
    // longer to compile the RSC entry on first request. /api/health
    // doesn't exist in dev (lives in production server.ts), so probe the
    // page under test instead.
    await waitForServer(BASE_URL, 45_000, { probe: "root" });
  });

  test.afterAll(async () => {
    server?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  });

  test("router.navigate between ?value=A/B/C re-renders the page", async ({ page }) => {
    await assertSearchParamNavigationUpdatesPage(page, BASE_URL);
  });
});
