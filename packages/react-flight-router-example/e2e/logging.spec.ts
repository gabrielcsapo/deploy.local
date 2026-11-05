import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { resolve } from "path";

const PORT = 3456;
const BASE_URL = `http://localhost:${PORT}`;
const SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");

let server: ChildProcess;
let stderr = "";

/**
 * Spawn the production server with FLIGHT_DEBUG=1 and capture stderr.
 * We use a dedicated port to avoid collisions with other test runs.
 */
test.beforeAll(async () => {
  stderr = "";
  server = spawn("node", [SERVER_SCRIPT], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      FLIGHT_DEBUG: "1",
      NO_COLOR: "1",
      PORT: String(PORT),
    },
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
      return; // server is up
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Server failed to start within 15s");
});

test.afterAll(async () => {
  server?.kill("SIGTERM");
  // Give it a moment to flush
  await new Promise((r) => setTimeout(r, 500));
});

/** Helper: wait for a pattern to appear in accumulated stderr */
async function waitForStderr(pattern: RegExp, timeoutMs = 5000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(stderr)) return stderr;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for stderr pattern: ${pattern}\nStderr so far:\n${stderr}`);
}

test.describe("Performance logging output", () => {
  test("SSR request logs flight timing", async ({ page }) => {
    const before = stderr.length;
    await page.goto(`${BASE_URL}/about`);

    await waitForStderr(/\[flight\] SSR \/about/);
    const newOutput = stderr.slice(before);

    // Headline should contain SSR and the path
    expect(newOutput).toMatch(/\[flight\] SSR \/about/);
    // Should include timing sub-entries
    expect(newOutput).toMatch(/matchRoutes/);
    expect(newOutput).toMatch(/buildSegmentMap/);
    expect(newOutput).toMatch(/rsc:serialize/);
    expect(newOutput).toMatch(/ssr:deserializeRSC/);
    expect(newOutput).toMatch(/ssr:renderToHTML/);
    // Should include duration values (e.g., "1.2ms" or "300µs")
    expect(newOutput).toMatch(/\d+(\.\d+)?(ms|µs|s)/);
  });

  test("RSC navigation request logs flight timing", async ({ page }) => {
    // First load a page to get the client JS
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");

    const before = stderr.length;
    // Navigate to about page via client-side navigation (triggers RSC fetch)
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    await waitForStderr(/\[flight\] RSC \/about/, 10000);
    const newOutput = stderr.slice(before);

    // RSC headline
    expect(newOutput).toMatch(/\[flight\] RSC \/about/);
    // Should include route matching and serialization timing
    expect(newOutput).toMatch(/matchRoutes/);
  });

  test("dynamic route params are masked in log output", async ({ page }) => {
    const before = stderr.length;
    await page.goto(`${BASE_URL}/posts/secret-post-id`);

    await waitForStderr(/\[flight\] SSR \/posts/);
    const newOutput = stderr.slice(before);

    // Should mask the param value with ****
    expect(newOutput).toMatch(/\[flight\] SSR \/posts\/\*\*\*\*/);
    // Should NOT contain the actual param value in the headline
    expect(newOutput).not.toMatch(/\[flight\] SSR \/posts\/secret-post-id/);
  });

  test("RSC navigation to dynamic route masks params", async ({ page }) => {
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");

    const before = stderr.length;
    // Navigate to a specific post (triggers RSC fetch with dynamic param)
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");

    // Use direct fetch to trigger RSC endpoint with dynamic param
    await page.evaluate(async () => {
      await fetch("/__rsc?url=/posts/my-secret-id", {
        headers: { Accept: "text/x-component" },
      });
    });

    await waitForStderr(/\[flight\] RSC \/posts\/\*\*\*\*/, 10000);
    const newOutput = stderr.slice(before);

    expect(newOutput).toMatch(/\[flight\] RSC \/posts\/\*\*\*\*/);
    expect(newOutput).not.toMatch(/\[flight\] RSC \/posts\/my-secret-id/);
  });
});
