import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const PORT = 3003;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");

let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("node", [SERVER_SCRIPT], {
    env: { ...process.env, PORT: String(PORT), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout!.on("data", () => {});
  server.stderr!.on("data", () => {});

  // Wait for the server to be ready
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      const data = await res.json();
      if (data.ok && !data.workers) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server without workers failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.describe("No-worker baseline", () => {
  test("actions work without workers", async ({ page }) => {
    await page.goto(`${BASE_URL}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");

    await page.fill("#delay", "100");
    await page.getByRole("button", { name: "Submit Action" }).click();

    await expect(page.getByTestId("action-result")).toBeVisible({ timeout: 10_000 });
    // Without workers, action runs on main thread
    await expect(page.getByTestId("thread-type")).toHaveText("main");
    await expect(page.getByTestId("delay-ms")).toHaveText("100ms");
  });

  test("getRequest() works without workers", async ({ page }) => {
    await page.goto(`${BASE_URL}/request-info`);
    await expect(page.locator("h1")).toHaveText("Request Info");
    await expect(page.getByTestId("request-method")).toHaveText("GET");
    await expect(page.getByTestId("no-request")).not.toBeVisible();
  });

  test("slow action timing (demonstrates worker benefit)", async ({ page }) => {
    // Submit a slow action (1s delay) via the UI
    await page.goto(`${BASE_URL}/actions`);
    await page.fill("#delay", "1000");
    await page.getByRole("button", { name: "Submit Action" }).click();

    // While the action is running, fetch the home page concurrently
    const pageStart = Date.now();
    const pageRes = await fetch(`${BASE_URL}/`);
    const pageTime = Date.now() - pageStart;

    expect(pageRes.status).toBe(200);

    // Without workers, the page response shares the event loop with the action.
    // This test documents the behavior rather than asserting a threshold,
    // since async I/O (setTimeout) yields to the event loop.
    // Compare with workers.spec.ts where pageTime < 1000ms with a 2s action.
    console.log(`[no-workers] Page response time during slow action: ${pageTime}ms`);
  });
});
