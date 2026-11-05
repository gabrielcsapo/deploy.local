import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");

let server: ChildProcess;

test.beforeAll(async () => {
  server = spawn("node", [SERVER_SCRIPT], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      WORKERS: "1",
      PORT: String(PORT),
      NO_COLOR: "1",
    },
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
      if (data.ok && data.workers) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server with workers failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

test.beforeEach(async () => {
  await fetch(`${BASE_URL}/api/timing`, { method: "DELETE" });
});

test.describe("Worker thread actions", () => {
  test("actions work with workers enabled", async ({ page }) => {
    await page.goto(`${BASE_URL}/actions`);
    await expect(page.locator("h1")).toHaveText("Server Actions");

    // Set a short delay
    await page.fill("#delay", "100");
    await page.getByRole("button", { name: "Submit Action" }).click();

    // Wait for result
    await expect(page.getByTestId("action-result")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("thread-type")).toHaveText("worker");
    await expect(page.getByTestId("delay-ms")).toHaveText("100ms");
  });

  test("getRequest() works in server components", async ({ page }) => {
    await page.goto(`${BASE_URL}/request-info`);
    await expect(page.locator("h1")).toHaveText("Request Info");

    // Should show request method
    await expect(page.getByTestId("request-method")).toHaveText("GET");

    // Should show headers table with at least user-agent
    const headersTable = page.getByTestId("headers-table");
    await expect(headersTable).toBeVisible();
    await expect(headersTable.locator("text=user-agent")).toBeVisible();

    // Should NOT show the "no request" error
    await expect(page.getByTestId("no-request")).not.toBeVisible();
  });

  test("getRequest() works in worker-dispatched actions", async ({ page }) => {
    await page.goto(`${BASE_URL}/actions`);
    await page.fill("#delay", "50");
    await page.getByRole("button", { name: "Submit Action" }).click();

    await expect(page.getByTestId("action-result")).toBeVisible({ timeout: 10_000 });

    // The action should have received the browser's user-agent
    const userAgent = await page.getByTestId("user-agent").textContent();
    expect(userAgent).toBeTruthy();
    expect(userAgent).not.toBe("unknown");
    // Playwright uses a Chromium-based user agent
    expect(userAgent).toContain("Mozilla");
  });

  test("page rendering is not blocked by slow actions", async ({ page }) => {
    // Submit a slow action (2s delay) via the UI — this uses proper RSC encoding
    await page.goto(`${BASE_URL}/actions`);
    await page.fill("#delay", "2000");
    await page.getByRole("button", { name: "Submit Action" }).click();

    // While the action is running, fetch the home page concurrently
    const pageStart = Date.now();
    const pageRes = await fetch(`${BASE_URL}/`);
    const pageTime = Date.now() - pageStart;

    expect(pageRes.status).toBe(200);
    const html = await pageRes.text();
    expect(html).toContain("Home");

    // Home page should respond in under 1s even while a 2s action runs on a worker
    expect(pageTime).toBeLessThan(1000);
  });

  test("concurrent requests are handled", async ({ page: _page }) => {
    // Fire 10 concurrent page requests to verify the server handles
    // concurrency correctly with workers enabled
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`${BASE_URL}/`).then(async (res) => ({
          status: res.status,
          ok: (await res.text()).includes("Home"),
        })),
      ),
    );
    const elapsed = Date.now() - start;

    // All should succeed
    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
    }

    // 10 concurrent page loads should complete in well under 5s
    expect(elapsed).toBeLessThan(5000);
  });

  test("shared workspace UI component renders and hydrates", async ({ page }) => {
    await page.goto(`${BASE_URL}/shared-ui`);
    await expect(page.getByTestId("shared-ui-heading")).toHaveText("Shared UI");
    await expect(page.getByTestId("shared-counter")).toBeVisible();

    // Verify initial state
    await expect(page.getByTestId("shared-counter-value")).toHaveText("0");

    // Click to verify client hydration works
    await page.getByTestId("shared-counter-button").click();
    await expect(page.getByTestId("shared-counter-value")).toHaveText("1");
  });

  test("timing events include worker-dispatched actions", async ({ page }) => {
    await page.goto(`${BASE_URL}/actions`);
    await page.fill("#delay", "50");
    await page.getByRole("button", { name: "Submit Action" }).click();
    await expect(page.getByTestId("action-result")).toBeVisible({ timeout: 10_000 });

    // Check timing events
    const res = await fetch(`${BASE_URL}/api/timing`);
    const events = await res.json();

    const actionEvent = events.find((e: { type: string }) => e.type === "ACTION");
    expect(actionEvent).toBeTruthy();
    expect(actionEvent.status).toBe(200);
    expect(actionEvent.totalMs).toBeGreaterThan(0);
  });
});
