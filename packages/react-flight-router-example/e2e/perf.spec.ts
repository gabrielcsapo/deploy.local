import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import { resolve } from "path";

const PORT = 3457;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");

let server: ChildProcess;
let stderr = "";

/**
 * Spawn the production server WITHOUT FLIGHT_DEBUG to confirm that
 * onRequestComplete works independently of debug logging.
 */
test.beforeAll(async () => {
  stderr = "";
  server = spawn("node", [SERVER_SCRIPT], {
    env: { ...process.env, NODE_ENV: "production", NO_COLOR: "1", PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  server.stdout!.on("data", () => {});

  // Wait for the server to be ready
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await fetch(BASE_URL);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Server failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
});

/** Clear the perf store before each test for isolation */
test.beforeEach(async () => {
  await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });
});

/** Helper: poll the perf API until it has at least `count` events */
async function waitForEvents(count: number, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE_URL}/api/perf/events?limit=100`);
    const events = await res.json();
    if (events.length >= count) return events;
    await new Promise((r) => setTimeout(r, 100));
  }
  const res = await fetch(`${BASE_URL}/api/perf/events?limit=100`);
  return res.json();
}

test.describe("onRequestComplete callback", () => {
  test("SSR request produces a timing event", async ({ page }) => {
    await page.goto(`${BASE_URL}/about`);
    await expect(page.locator("h1")).toHaveText("About");

    const events = await waitForEvents(1);
    const ssrEvent = events.find(
      (e: { type: string; pathname: string }) => e.type === "SSR" && e.pathname.includes("/about"),
    );

    expect(ssrEvent).toBeTruthy();
    expect(ssrEvent.status).toBe(200);
    expect(ssrEvent.totalMs).toBeGreaterThan(0);
    expect(ssrEvent.timestamp).toBeTruthy();
    expect(Array.isArray(ssrEvent.timings)).toBe(true);
    expect(ssrEvent.timings.length).toBeGreaterThan(0);

    // Should include standard timing labels
    const labels = ssrEvent.timings.map((t: { label: string }) => t.label);
    expect(labels).toContain("matchRoutes");
    expect(labels).toContain("buildSegmentMap");
  });

  test("RSC client navigation produces a timing event", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");

    // Clear events so we only capture the RSC navigation
    await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });

    // Client-side navigate to About
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    const events = await waitForEvents(1);
    const rscEvent = events.find(
      (e: { type: string; pathname: string }) => e.type === "RSC" && e.pathname.includes("/about"),
    );

    expect(rscEvent).toBeTruthy();
    expect(rscEvent.status).toBe(200);
    expect(rscEvent.totalMs).toBeGreaterThan(0);
    expect(rscEvent.timings.length).toBeGreaterThan(0);

    const labels = rscEvent.timings.map((t: { label: string }) => t.label);
    expect(labels).toContain("matchRoutes");
  });

  test("timing entries have correct shape", async ({ page }) => {
    await page.goto(`${BASE_URL}/about`);

    const events = await waitForEvents(1);
    const event = events[0];

    // Every timing entry should have label, depth, and optionally durationMs
    for (const entry of event.timings) {
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.depth).toBe("number");
      expect(entry.depth).toBeGreaterThanOrEqual(0);
      if (entry.durationMs !== undefined) {
        expect(typeof entry.durationMs).toBe("number");
        expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("events work without FLIGHT_DEBUG (no stderr output)", async ({ page }) => {
    const stderrBefore = stderr.length;

    await page.goto(`${BASE_URL}/about`);

    const events = await waitForEvents(1);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Since FLIGHT_DEBUG is not set, there should be no [flight] timing in stderr
    const newStderr = stderr.slice(stderrBefore);
    expect(newStderr).not.toMatch(/\[flight\] SSR/);
  });

  test("DELETE /api/perf/events clears all events", async ({ page }) => {
    // Generate some events
    await page.goto(`${BASE_URL}/`);
    let events = await waitForEvents(1);
    expect(events.length).toBeGreaterThanOrEqual(1);

    // Clear
    const clearRes = await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });
    const clearBody = await clearRes.json();
    expect(clearBody.ok).toBe(true);

    // Verify empty
    const res = await fetch(`${BASE_URL}/api/perf/events?limit=100`);
    events = await res.json();
    expect(events.length).toBe(0);
  });

  test("perf dashboard page renders", async ({ page }) => {
    // Generate a few events first
    await page.goto(`${BASE_URL}/`);
    await waitForEvents(1);

    // Navigate to the perf dashboard
    await page.goto(`${BASE_URL}/perf`);
    await expect(page.locator("h1")).toHaveText("Performance Dashboard");
    await expect(page.locator("text=onRequestComplete")).toBeVisible();

    // Dashboard should show at least the SSR event from the initial page load
    // Wait for the client component to fetch and render events
    await expect(page.locator("table")).toBeVisible({ timeout: 10_000 });
    // There should be at least 1 row (the SSR for /perf itself)
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });
  });

  test("perf dashboard shows correct event types", async ({ page }) => {
    // Generate SSR event
    await page.goto(`${BASE_URL}/about`);
    await waitForEvents(1);

    // Navigate to perf dashboard
    await page.goto(`${BASE_URL}/perf`);
    await expect(page.locator("h1")).toHaveText("Performance Dashboard");

    // Wait for at least one event row to appear
    await expect(page.locator("tbody tr").first()).toBeVisible({ timeout: 10_000 });

    // Should show SSR badge(s)
    await expect(page.locator("text=SSR").first()).toBeVisible();
  });

  test("multiple request types are captured", async ({ page }) => {
    // SSR request
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");

    // Clear to start fresh
    await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });

    // Another SSR
    await page.goto(`${BASE_URL}/about`);
    await page.waitForLoadState("networkidle");

    // Now client-side navigate to trigger RSC
    await page.getByRole("link", { name: "Home" }).first().click();
    await expect(page.locator("h1")).toHaveText("Home");

    const events = await waitForEvents(2);

    const types = events.map((e: { type: string }) => e.type);
    expect(types).toContain("SSR");
    expect(types).toContain("RSC");
  });
});

test.describe("cancelled request tracking", () => {
  test("cancelled RSC request produces a cancelled event", async () => {
    // Use Node.js http.request to make a request we can forcefully destroy.
    // Browser fetch with HTTP/1.1 keep-alive doesn't close the TCP socket
    // when aborted, so the server can't detect the disconnection. Destroying
    // the http.request socket triggers the server's socket close event.
    await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });

    const req = http.request({
      hostname: "localhost",
      port: PORT,
      path: "/__rsc?url=%2Fslow",
      headers: { Connection: "close" },
    });
    req.on("error", () => {}); // Ignore socket errors from destroy()
    req.end();

    // Let the request reach the server and start the 3s render
    await new Promise((r) => setTimeout(r, 500));

    // Destroy the connection — triggers socket close on the server
    req.destroy();

    // Wait for the server to finish rendering and record the cancelled event
    const events = await waitForEvents(1, 10_000);
    const cancelledEvent = events.find(
      (e: { cancelled?: boolean; pathname: string }) =>
        e.cancelled === true && e.pathname.includes("/slow"),
    );
    expect(cancelledEvent).toBeTruthy();
    expect(cancelledEvent.type).toBe("RSC");
  });

  test("non-cancelled request does not have cancelled flag", async ({ page }) => {
    await page.goto(`${BASE_URL}/about`);
    await expect(page.locator("h1")).toHaveText("About");

    const events = await waitForEvents(1);
    const aboutEvent = events.find((e: { pathname: string }) => e.pathname.includes("/about"));

    expect(aboutEvent).toBeTruthy();
    expect(aboutEvent.cancelled).toBeFalsy();
  });
});
