import { execSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const rootDir = resolve(import.meta.dirname, "../../..");
const exampleDir = resolve(rootDir, "packages/react-flight-router-example");
const docsContentDir = resolve(import.meta.dirname, "../content");
const targetFile = resolve(docsContentDir, "guides/debugging.mdx");

/** Markers for terminal output blocks (```code```) */
const OUTPUT_MARKERS = {
  ssr: { start: "{/* SSR_OUTPUT_START */}", end: "{/* SSR_OUTPUT_END */}" },
  rsc: { start: "{/* RSC_OUTPUT_START */}", end: "{/* RSC_OUTPUT_END */}" },
  rscParam: { start: "{/* RSC_PARAM_OUTPUT_START */}", end: "{/* RSC_PARAM_OUTPUT_END */}" },
  action: { start: "{/* ACTION_OUTPUT_START */}", end: "{/* ACTION_OUTPUT_END */}" },
} as const;

/** Markers for JSON sample data blocks (```json```) */
const JSON_MARKERS = {
  ssrJson: { start: "{/* SSR_JSON_START */}", end: "{/* SSR_JSON_END */}" },
  rscJson: { start: "{/* RSC_JSON_START */}", end: "{/* RSC_JSON_END */}" },
  rscSlowJson: { start: "{/* RSC_SLOW_JSON_START */}", end: "{/* RSC_SLOW_JSON_END */}" },
  rscCancelledJson: {
    start: "{/* RSC_CANCELLED_JSON_START */}",
    end: "{/* RSC_CANCELLED_JSON_END */}",
  },
  actionJson: { start: "{/* ACTION_JSON_START */}", end: "{/* ACTION_JSON_END */}" },
} as const;

const PORT = 3210;
const BASE_URL = `http://localhost:${PORT}`;

async function waitForServer(deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    try {
      await fetch(BASE_URL);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("Server failed to start within timeout");
}

/** Fetch the most recent event from the perf API, optionally matching a type */
async function fetchLatestEvent(type?: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BASE_URL}/api/perf/events?limit=10`);
  if (!res.ok) return null;
  const events = (await res.json()) as Record<string, unknown>[];
  if (type) {
    return events.find((e) => e.type === type) ?? null;
  }
  return events[0] ?? null;
}

/** Clear the perf event buffer */
async function clearPerfEvents(): Promise<void> {
  await fetch(`${BASE_URL}/api/perf/events`, { method: "DELETE" });
}

/**
 * Format an event for the docs JSON block.
 * Strips the "total" timing entry and rounds numbers for readability.
 */
function formatEventJson(event: Record<string, unknown>): string {
  const cleaned = { ...event };
  // Round totalMs for readability
  if (typeof cleaned.totalMs === "number") {
    cleaned.totalMs = round(cleaned.totalMs);
  }
  // Remove the "total" timing entry, normalize depths to start at 0, and round numbers
  if (Array.isArray(cleaned.timings)) {
    const timings = (cleaned.timings as Record<string, unknown>[]).filter(
      (t) => t.label !== "total",
    );
    // Find the minimum depth so we can normalize to 0-based
    const minDepth = timings.reduce((min, t) => Math.min(min, (t.depth as number) ?? 0), Infinity);
    const depthOffset = Number.isFinite(minDepth) ? minDepth : 0;
    cleaned.timings = timings.map((t) => {
      const entry: Record<string, unknown> = { label: t.label };
      if (typeof t.durationMs === "number") entry.durationMs = round(t.durationMs);
      entry.depth = (t.depth as number) - depthOffset;
      if (typeof t.offsetMs === "number") entry.offsetMs = round(t.offsetMs);
      if (t.parallel) entry.parallel = true;
      return entry;
    });
  }
  return JSON.stringify(cleaned, null, 2);
}

/** Round to 3 decimal places to avoid noisy floating-point precision */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Path to the generated dashboard sample events file */
const dashboardSampleFile = resolve(
  import.meta.dirname,
  "../src/generated/perf-sample-events.json",
);

interface CapturedOutput {
  ssr: string;
  rsc: string;
  rscParam: string;
  action: string;
  ssrJson: string;
  rscJson: string;
  rscSlowJson: string;
  rscCancelledJson: string;
  actionJson: string;
  /** Raw events for the PerfDashboardSample component */
  dashboardEvents: Record<string, unknown>[];
}

async function captureRuntimeOutput(): Promise<CapturedOutput | null> {
  let server: ChildProcess | null = null;

  try {
    // Build the library first
    console.log("Building react-flight-router library...");
    execSync("pnpm build:lib", { cwd: rootDir, stdio: "pipe" });

    // Build the example app
    console.log("Building example app...");
    execSync("npx react-flight-router build", { cwd: exampleDir, stdio: "pipe" });

    // Start the production server with debug logging and NO_COLOR
    console.log("Starting production server with FLIGHT_DEBUG=1...");
    server = spawn("node", [resolve(exampleDir, "dist/server.js")], {
      env: {
        ...process.env,
        NODE_ENV: "production",
        FLIGHT_DEBUG: "1",
        NO_COLOR: "1",
        PORT: String(PORT),
      },
      stdio: ["ignore", "pipe", "pipe"],
      cwd: exampleDir,
    });

    let stderr = "";
    let stdout = "";
    server.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    server.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    // Detect early exit
    let exited = false;
    server.on("exit", (code) => {
      exited = true;
      if (code !== null && code !== 0) {
        console.error(`Server exited with code ${code}`);
        console.error("stdout:", stdout);
        console.error("stderr:", stderr);
      }
    });

    await waitForServer(Date.now() + 15_000);
    if (exited) throw new Error("Server exited before becoming ready");
    console.log("Server is ready.");

    // Launch a headless browser to drive real interactions
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();

    // ── 1. SSR: initial page load ──
    await clearPerfEvents();
    stderr = "";
    console.log("Requesting SSR /about ...");
    await page.goto(`${BASE_URL}/about`);
    await waitForPattern(() => stderr, /\[flight\] SSR/);
    const ssrOutput = extractFlightBlock(stderr);
    // Wait a moment for the event to be recorded
    await new Promise((r) => setTimeout(r, 200));
    const ssrEvent = await fetchLatestEvent("SSR");

    // ── 2. RSC: client-side navigation ──
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await clearPerfEvents();
    stderr = "";
    console.log("Clicking link to /about (RSC navigation) ...");
    await page.getByRole("link", { name: "About" }).first().click();
    await page.waitForSelector("h1:has-text('About')");
    await waitForPattern(() => stderr, /\[flight\] RSC/);
    const rscOutput = extractFlightBlock(stderr);
    await new Promise((r) => setTimeout(r, 200));
    const rscEvent = await fetchLatestEvent("RSC");

    // ── 3. RSC with dynamic param (shows **** masking) ──
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");
    await clearPerfEvents();
    stderr = "";
    console.log("Clicking link to /posts/:id (RSC with param) ...");
    await page.locator('a[href^="/posts/"]').first().click();
    await page.waitForLoadState("networkidle");
    await waitForPattern(() => stderr, /\[flight\] RSC \/posts\/\*\*\*\*/);
    const rscParamOutput = extractFlightBlock(stderr);

    // ── 4. RSC slow route (async rendering with rsc:stream) ──
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await clearPerfEvents();
    stderr = "";
    console.log("Clicking link to /slow (RSC slow route) ...");
    await page.getByRole("link", { name: "Slow" }).first().click();
    // Wait for the slow page to fully render (3s delay)
    await page.waitForSelector("h1:has-text('Slow')", { timeout: 10_000 });
    await waitForPattern(() => stderr, /\[flight\] RSC/, 10_000);
    await new Promise((r) => setTimeout(r, 200));
    const rscSlowEvent = await fetchLatestEvent("RSC");

    // ── 5. RSC cancelled (navigate away during slow render) ──
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await clearPerfEvents();
    stderr = "";
    console.log("Clicking /slow then navigating away (cancelled) ...");
    await page.getByRole("link", { name: "Slow" }).first().click();
    // Wait a moment then navigate away before the 3s delay completes
    await new Promise((r) => setTimeout(r, 500));
    await page.getByRole("link", { name: "About" }).first().click();
    await page.waitForSelector("h1:has-text('About')");
    // Wait for the cancelled event to be recorded
    await waitForPattern(() => stderr, /\[CANCELLED\]/, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    const rscCancelledEvent = await fetchLatestEvent();
    // Find the cancelled one specifically
    const cancelledRes = await fetch(`${BASE_URL}/api/perf/events?limit=10`);
    const cancelledEvents = (await cancelledRes.json()) as Record<string, unknown>[];
    const cancelledEvent = cancelledEvents.find((e) => e.cancelled === true) ?? rscCancelledEvent;

    // ── 6. ACTION: server action ──
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    await clearPerfEvents();
    stderr = "";
    console.log("Submitting message form (ACTION) ...");
    await page.fill('input[name="text"]', "hello from capture script");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForPattern(() => stderr, /\[flight\] ACTION/, 10000);
    const actionOutput = extractFlightBlock(stderr);
    await new Promise((r) => setTimeout(r, 200));
    const actionEvent = await fetchLatestEvent("ACTION");

    await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));

    // If a real cancelled event wasn't captured (server completed before detecting
    // disconnect), synthesize one from the slow event with truncated timings.
    let cancelledForDashboard = cancelledEvent;
    if (cancelledForDashboard && !cancelledForDashboard.cancelled && rscSlowEvent) {
      const slowTimings = (rscSlowEvent.timings as Record<string, unknown>[]) ?? [];
      cancelledForDashboard = {
        ...rscSlowEvent,
        // Remove rsc:stream (cancelled before stream could complete)
        timings: slowTimings.filter((t) => t.label !== "rsc:stream"),
        cancelled: true,
      };
    }

    // Collect all events for the dashboard sample (filter nulls)
    const dashboardEvents = [
      ssrEvent,
      rscEvent,
      actionEvent,
      rscSlowEvent,
      cancelledForDashboard,
    ].filter((e): e is Record<string, unknown> => e != null);

    return {
      ssr: ssrOutput,
      rsc: rscOutput,
      rscParam: rscParamOutput,
      action: actionOutput,
      ssrJson: ssrEvent ? formatEventJson(ssrEvent) : "",
      rscJson: rscEvent ? formatEventJson(rscEvent) : "",
      rscSlowJson: rscSlowEvent ? formatEventJson(rscSlowEvent) : "",
      rscCancelledJson: cancelledForDashboard ? formatEventJson(cancelledForDashboard) : "",
      actionJson: actionEvent ? formatEventJson(actionEvent) : "",
      dashboardEvents: dashboardEvents.map((e) => JSON.parse(formatEventJson(e))),
    };
  } catch (err) {
    console.error("Failed to capture runtime output:", err instanceof Error ? err.message : err);
    server?.kill("SIGTERM");
    return null;
  }
}

function extractFlightBlock(stderr: string): string {
  // Extract lines from the first [flight] headline through the end of the timing block
  const lines = stderr.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("[flight]"));
  if (startIdx === -1) return stderr.trim();

  // Collect the headline + all indented timing lines that follow
  const block = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].match(/^\s+\S/) && !lines[i].includes("[flight]")) {
      block.push(lines[i]);
    } else {
      break;
    }
  }
  return block.join("\n");
}

async function waitForPattern(
  getStderr: () => string,
  pattern: RegExp,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(getStderr())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Map of all marker keys to their heading text (for JSON blocks) */
const JSON_HEADINGS: Record<string, string> = {
  ssrJson: "**SSR (initial page load)**",
  rscJson: "**RSC (client-side navigation)**",
  rscSlowJson:
    "**RSC (slow route with async rendering)**\n\nWhen a route has Suspense boundaries or async data fetching, the `rsc:stream` entry captures the time spent during stream consumption:",
  rscCancelledJson:
    "**RSC (cancelled — client navigated away)**\n\nWhen the client disconnects before the response stream is fully consumed (e.g., the user navigates to a different page while a slow route is still rendering), the event includes `cancelled: true`:",
  actionJson: "**ACTION (server action)**",
};

function injectIntoMarkdown(outputs: CapturedOutput): void {
  const md = readFileSync(targetFile, "utf-8");
  let updated = md;

  // Inject terminal output blocks
  for (const [key, { start, end }] of Object.entries(OUTPUT_MARKERS)) {
    const startIdx = updated.indexOf(start);
    const endIdx = updated.indexOf(end);
    if (startIdx === -1 || endIdx === -1) {
      console.warn(`Markers for ${key} not found in ${targetFile} — skipping`);
      continue;
    }
    const before = updated.slice(0, startIdx + start.length);
    const after = updated.slice(endIdx);
    const output = outputs[key as keyof CapturedOutput];
    updated = `${before}\n\`\`\`\n${output}\n\`\`\`\n${after}`;
  }

  // Inject JSON sample data blocks
  for (const [key, { start, end }] of Object.entries(JSON_MARKERS)) {
    const startIdx = updated.indexOf(start);
    const endIdx = updated.indexOf(end);
    if (startIdx === -1 || endIdx === -1) {
      console.warn(`JSON markers for ${key} not found in ${targetFile} — skipping`);
      continue;
    }
    const json = outputs[key as keyof CapturedOutput];
    if (!json) {
      console.warn(`No JSON data captured for ${key} — skipping`);
      continue;
    }
    const before = updated.slice(0, startIdx + start.length);
    const after = updated.slice(endIdx);
    const heading = JSON_HEADINGS[key] ?? "";
    updated = `${before}\n\n${heading}\n\n\`\`\`json\n${json}\n\`\`\`\n\n${after}`;
  }

  writeFileSync(targetFile, updated, "utf-8");
  console.log("Runtime output injected into debugging.mdx");

  // Write dashboard sample events JSON
  if (outputs.dashboardEvents.length > 0) {
    writeFileSync(
      dashboardSampleFile,
      JSON.stringify(outputs.dashboardEvents, null, 2) + "\n",
      "utf-8",
    );
    console.log(`Dashboard sample events written to ${dashboardSampleFile}`);
  }
}

const output = await captureRuntimeOutput();
if (output) {
  injectIntoMarkdown(output);
} else {
  console.log("Skipping injection — using existing runtime output in docs.");
}
