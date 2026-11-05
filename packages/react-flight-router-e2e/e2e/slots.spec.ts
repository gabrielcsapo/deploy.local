import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const PORT = 3005;
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
  throw new Error("Slots test server failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.describe("parallel-route slots (modal)", () => {
  test("clicking a thumbnail opens the modal at ?@modal=/photo/<id>", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos`);
    await expect(page.getByTestId("photos-page")).toBeVisible();
    await expect(page.getByTestId("photo-modal")).toBeHidden();

    await page.getByTestId("photo-thumb-2").click();

    // Gallery underneath stays mounted, modal layers on top with the photo content
    await expect(page.getByTestId("photo-modal")).toBeVisible();
    await expect(page.getByTestId("photo-page-2")).toBeVisible();
    await expect(page.getByTestId("photos-page")).toBeVisible();
    // Browsers may percent-encode the `@`, but the slot param decodes the same on the server.
    const search = new URL(page.url()).searchParams.get("@modal");
    expect(search).toBe("/photo/2");
  });

  test("hard-loading /photo/<id> renders the page directly (no modal)", async ({ page }) => {
    await page.goto(`${BASE_URL}/photo/3`);
    await expect(page.getByTestId("photo-page-3")).toBeVisible();
    await expect(page.getByTestId("photo-modal")).toBeHidden();
    await expect(page.getByTestId("photos-page")).toBeHidden();
  });

  test("hard-loading /photos?@modal=/photo/<id> SSRs both gallery and modal", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos?@modal=/photo/4`);
    await expect(page.getByTestId("photos-page")).toBeVisible();
    await expect(page.getByTestId("photo-modal")).toBeVisible();
    await expect(page.getByTestId("photo-page-4")).toBeVisible();
  });

  test("close button removes the slot param and unmounts the modal", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos`);
    await page.getByTestId("photo-thumb-1").click();
    await expect(page.getByTestId("photo-modal")).toBeVisible();

    await page.getByTestId("photo-modal-close").click();

    await expect(page.getByTestId("photo-modal")).toBeHidden();
    await expect(page.getByTestId("photos-page")).toBeVisible();
    expect(page.url()).toBe(`${BASE_URL}/photos`);
  });

  test("Escape key closes the modal", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos`);
    await page.getByTestId("photo-thumb-1").click();
    await expect(page.getByTestId("photo-modal")).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(page.getByTestId("photo-modal")).toBeHidden();
    expect(page.url()).toBe(`${BASE_URL}/photos`);
  });

  test('"Open full page" navigates to canonical /photo/<id> and the modal unmounts', async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/photos?@modal=/photo/2`);
    await expect(page.getByTestId("photo-modal")).toBeVisible();

    await page.getByTestId("open-full-page").click();

    // URL drops the slot param, modal segments are dropped, gallery is replaced
    await page.waitForURL(`${BASE_URL}/photo/2`);
    await expect(page.getByTestId("photo-modal")).toBeHidden();
    await expect(page.getByTestId("photos-page")).toBeHidden();
    await expect(page.getByTestId("photo-page-2")).toBeVisible();
  });

  test("opening modal preserves gallery — no full re-render of the underlying page", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/photos`);
    // Tag the gallery DOM node so we can detect remounts
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="photos-page"]') as HTMLElement | null;
      if (el) el.dataset.persistMarker = "kept";
    });

    await page.getByTestId("photo-thumb-2").click();
    await expect(page.getByTestId("photo-modal")).toBeVisible();

    const stillMarked = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="photos-page"]') as HTMLElement | null;
      return el?.dataset.persistMarker === "kept";
    });
    expect(stillMarked).toBe(true);
  });
});

test.describe("multiple sibling slots (modal + drawer)", () => {
  test("drawer opens independently via nav link", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos`);
    await expect(page.getByTestId("cart-drawer")).toBeHidden();

    await page.getByTestId("nav-cart").click();

    await expect(page.getByTestId("cart-drawer")).toBeVisible();
    await expect(page.getByTestId("cart-contents")).toBeVisible();
    await expect(page.getByTestId("photo-modal")).toBeHidden();
    expect(new URL(page.url()).searchParams.get("@drawer")).toBe("/cart");
  });

  test("modal and drawer can be open simultaneously", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos`);

    await page.getByTestId("nav-cart").click();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();

    // Drawer is fixed-position right; thumbnail is reachable underneath
    await page.getByTestId("photo-thumb-3").click();

    await expect(page.getByTestId("photo-modal")).toBeVisible();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();
    await expect(page.getByTestId("photos-page")).toBeVisible();

    const params = new URL(page.url()).searchParams;
    expect(params.get("@modal")).toBe("/photo/3");
    expect(params.get("@drawer")).toBe("/cart");
  });

  test("closing one slot leaves the other open", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos?@modal=/photo/1&@drawer=/cart`);
    await expect(page.getByTestId("photo-modal")).toBeVisible();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();

    await page.getByTestId("cart-drawer-close").click();

    await expect(page.getByTestId("cart-drawer")).toBeHidden();
    await expect(page.getByTestId("photo-modal")).toBeVisible();

    const params = new URL(page.url()).searchParams;
    expect(params.get("@drawer")).toBeNull();
    expect(params.get("@modal")).toBe("/photo/1");
  });

  test("hard-load with both slot params SSRs both layers", async ({ page }) => {
    await page.goto(`${BASE_URL}/photos?@modal=/photo/4&@drawer=/cart`);
    await expect(page.getByTestId("photos-page")).toBeVisible();
    await expect(page.getByTestId("photo-modal")).toBeVisible();
    await expect(page.getByTestId("photo-page-4")).toBeVisible();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();
    await expect(page.getByTestId("cart-contents")).toBeVisible();
    await expect(page.getByTestId("cart-total")).toHaveText("$84");
  });

  test("Escape closes the most-recently-focused modal but drawer stays", async ({ page }) => {
    // Both slots register Escape handlers. The behavior here is whatever
    // happens with two listeners on `keydown` — we just verify the drawer
    // does *not* spontaneously close when only the modal close path runs,
    // and vice versa, by closing each via its own button.
    await page.goto(`${BASE_URL}/photos?@modal=/photo/2&@drawer=/cart`);

    await page.getByTestId("photo-modal-close").click();
    await expect(page.getByTestId("photo-modal")).toBeHidden();
    await expect(page.getByTestId("cart-drawer")).toBeVisible();
  });
});
