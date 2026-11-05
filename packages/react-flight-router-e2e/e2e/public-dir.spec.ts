import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Regression test for publicDir support.
 *
 * The build orchestrator copies `<appRoot>/public` into the client build
 * output via Vite's `publicDir` option, and the production server registers
 * an explicit GET route per top-level file. The vite dev server picks the
 * same `<root>/public` up natively. This spec verifies both paths actually
 * serve the files with the expected bytes and content types so neither
 * path silently regresses.
 *
 * Files under public/ for this package:
 *   - robots.txt                       (text/plain)
 *   - favicon.svg                      (image/svg+xml)
 *   - deep/a/b/c/d/e/nested.txt        (text/plain — five directories deep)
 *
 * The nested file guards against the server-side handler only registering
 * top-level routes: the build step copies the whole tree verbatim, but the
 * server has to walk subdirectories to discover them.
 */

const PROD_PORT = 3010;
const DEV_PORT = 3011;

const PROD_SERVER_SCRIPT = resolve(import.meta.dirname, "../dist/server.js");
const E2E_PACKAGE_DIR = resolve(import.meta.dirname, "..");
const VITE_BIN = resolve(E2E_PACKAGE_DIR, "node_modules/.bin/vite");
const PUBLIC_DIR = resolve(E2E_PACKAGE_DIR, "public");

const NESTED_REL_PATH = "deep/a/b/c/d/e/nested.txt";

const ROBOTS_TXT_EXPECTED = readFileSync(resolve(PUBLIC_DIR, "robots.txt"), "utf8");
const FAVICON_SVG_EXPECTED = readFileSync(resolve(PUBLIC_DIR, "favicon.svg"), "utf8");
const NESTED_TXT_EXPECTED = readFileSync(resolve(PUBLIC_DIR, NESTED_REL_PATH), "utf8");

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
        // Vite dev doesn't ship /api/health (lives in server.ts). Probe the
        // root page — a 200 means vite has compiled and is serving routes.
        const res = await fetch(`${baseUrl}/`);
        if (res.ok) return;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Server at ${baseUrl} failed to start within ${timeoutMs}ms`);
}

/**
 * Core assertions, parameterized by base URL. We don't assert on
 * Cache-Control here — the prod server sets one, vite dev doesn't,
 * and the contract worth guarding is "the file is served with the
 * right bytes and a sensible content type."
 */
async function assertPublicDirFilesAreServed(baseUrl: string): Promise<void> {
  const robots = await fetch(`${baseUrl}/robots.txt`);
  expect(robots.status).toBe(200);
  expect(robots.headers.get("content-type") ?? "").toContain("text/plain");
  expect(await robots.text()).toBe(ROBOTS_TXT_EXPECTED);

  const favicon = await fetch(`${baseUrl}/favicon.svg`);
  expect(favicon.status).toBe(200);
  expect(favicon.headers.get("content-type") ?? "").toContain("image/svg+xml");
  expect(await favicon.text()).toBe(FAVICON_SVG_EXPECTED);

  // Five-levels-deep nested file. Confirms the server walks the publicDir
  // tree, not just the top level.
  const nested = await fetch(`${baseUrl}/${NESTED_REL_PATH}`);
  expect(nested.status).toBe(200);
  expect(nested.headers.get("content-type") ?? "").toContain("text/plain");
  expect(await nested.text()).toBe(NESTED_TXT_EXPECTED);

  // A request for a non-existent file inside the same nested directory
  // must NOT be intercepted (no wildcard match) — same 404 contract as a
  // top-level miss.
  const nestedMissing = await fetch(`${baseUrl}/deep/a/b/c/d/e/does-not-exist.txt`);
  expect(nestedMissing.status).toBe(404);

  // Unknown public file 404s (and doesn't, e.g., return an SSR HTML shell).
  const missing = await fetch(`${baseUrl}/this-file-does-not-exist.txt`);
  expect(missing.status).toBe(404);
}

test.describe("publicDir — production server", () => {
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

  test("serves public/ files copied into the build output", async () => {
    await assertPublicDirFilesAreServed(BASE_URL);
  });

  test("public file responses include a Cache-Control header", async () => {
    // The prod server adds a short-TTL Cache-Control for unhashed public
    // files. Vite dev doesn't, so this assertion only runs against prod.
    const res = await fetch(`${BASE_URL}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control") ?? "").toMatch(/max-age=\d+/);
  });
});

test.describe("publicDir — vite dev server", () => {
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

  test("serves public/ files from the vite dev root", async () => {
    await assertPublicDirFilesAreServed(BASE_URL);
  });
});
