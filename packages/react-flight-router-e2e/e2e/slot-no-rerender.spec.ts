import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

/**
 * Regression test for slot-param-only navigations re-rendering the main tree.
 *
 * Before the `nonSlotSearchKey` fix in rsc-renderer.ts, toggling a parallel-
 * route slot (e.g. opening or closing a modal via `?@modal=...`) flipped
 * `searchChanged` to `true` in diffSegments, which forced a full re-render
 * of every matched segment in the underlying tree. Closing a modal would
 * silently re-fetch the gallery the user was already looking at.
 *
 * The page exposes `photos-page-render-id` — a per-server-render fingerprint.
 * If the server re-renders the gallery, the id changes. If the client kept
 * the existing segment (the correct behavior), the id stays the same.
 *
 * Covers both the production server and the vite dev server, since dev-mode
 * HMR runs a separate transform pipeline that can regress independently.
 */

const PROD_PORT = 3008;
const DEV_PORT = 3009;

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
        const res = await fetch(`${baseUrl}/photos`);
        if (res.ok) return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${baseUrl} failed to start within ${timeoutMs}ms`);
}

async function getRenderId(page: Page): Promise<string> {
  const text = await page.getByTestId("photos-page-render-id").textContent();
  expect(text).toBeTruthy();
  return text!;
}

async function assertSlotToggleDoesNotRerenderUnderlyingTree(
  page: Page,
  baseUrl: string,
): Promise<void> {
  await page.goto(`${baseUrl}/photos`);
  await expect(page.getByTestId("photos-page")).toBeVisible();
  // Wait for client-side hydration to attach the Link onClick handler.
  // Without this, vite dev's first click can race the hydration and the
  // <a href> triggers a hard navigation instead of a soft nav, which
  // (correctly) re-SSRs the page — but masks what we're trying to test.
  await page.waitForLoadState("networkidle");

  const renderIdBefore = await getRenderId(page);

  // Open the modal — only `?@modal=/photo/2` is added. The gallery below
  // must NOT be re-rendered.
  await page.getByTestId("photo-thumb-2").click();
  await expect(page.getByTestId("photo-modal")).toBeVisible();
  await expect(page.getByTestId("photo-page-2")).toBeVisible();
  await expect(page.getByTestId("photos-page")).toBeVisible();

  const renderIdAfterOpen = await getRenderId(page);
  expect(renderIdAfterOpen).toBe(renderIdBefore);

  // Close with Escape — `?@modal` is stripped. Same invariant: gallery
  // stays as-is, server returns only the segmentKeys delta, the client
  // keeps the existing gallery segment.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("photo-modal")).toBeHidden();
  await expect(page.getByTestId("photos-page")).toBeVisible();

  const renderIdAfterClose = await getRenderId(page);
  expect(renderIdAfterClose).toBe(renderIdBefore);

  // Sanity check: clicking the close button should also not re-render.
  await page.getByTestId("photo-thumb-3").click();
  await expect(page.getByTestId("photo-modal")).toBeVisible();
  await page.getByTestId("photo-modal-close").click();
  await expect(page.getByTestId("photo-modal")).toBeHidden();

  const renderIdAfterButtonClose = await getRenderId(page);
  expect(renderIdAfterButtonClose).toBe(renderIdBefore);
}

async function assertRealSearchParamStillReRenders(page: Page, baseUrl: string): Promise<void> {
  // The fix excludes slot params from the search-change check, but real
  // user-facing query params must still trigger a re-render. We verify
  // this hasn't been overcorrected by hitting /search-params, which
  // exercises a non-slot query param.
  await page.goto(`${baseUrl}/search-params?value=A`);
  const idA = await page.getByTestId("search-params-render-id").textContent();
  expect(idA).toBeTruthy();

  await page.getByTestId("link-value-b").click();
  await expect(page).toHaveURL(`${baseUrl}/search-params?value=B`);
  await expect(page.getByTestId("search-params-value")).toHaveText("B");

  const idB = await page.getByTestId("search-params-render-id").textContent();
  expect(idB).toBeTruthy();
  expect(idB).not.toEqual(idA);
}

test.describe("Slot toggle does not re-render underlying tree — production", () => {
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

  test("opening and closing modal preserves gallery render id", async ({ page }) => {
    await assertSlotToggleDoesNotRerenderUnderlyingTree(page, BASE_URL);
  });

  test("non-slot search param changes still force a re-render", async ({ page }) => {
    await assertRealSearchParamStillReRenders(page, BASE_URL);
  });
});

test.describe("Slot toggle does not re-render underlying tree — vite dev", () => {
  const BASE_URL = `http://localhost:${DEV_PORT}`;
  let server: ChildProcess;

  test.beforeAll(async () => {
    server = spawn(VITE_BIN, ["--port", String(DEV_PORT), "--strictPort"], {
      cwd: E2E_PACKAGE_DIR,
      env: { ...process.env, NODE_ENV: "development", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout!.on("data", () => {});
    server.stderr!.on("data", () => {});
    await waitForServer(BASE_URL, 45_000, { probe: "root" });
  });

  test.afterAll(async () => {
    server?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  });

  test("opening and closing modal preserves gallery render id", async ({ page }) => {
    await assertSlotToggleDoesNotRerenderUnderlyingTree(page, BASE_URL);
  });

  test("non-slot search param changes still force a re-render", async ({ page }) => {
    await assertRealSearchParamStillReRenders(page, BASE_URL);
  });
});
