import { execSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const rootDir = resolve(import.meta.dirname, "../../..");
const exampleDir = resolve(rootDir, "packages/react-flight-router-example");
const docsContentDir = resolve(import.meta.dirname, "../content");
const targetFile = resolve(docsContentDir, "guides/debugging.mdx");

const MARKERS = {
  ssr: { start: "{/* SSR_OUTPUT_START */}", end: "{/* SSR_OUTPUT_END */}" },
  rsc: { start: "{/* RSC_OUTPUT_START */}", end: "{/* RSC_OUTPUT_END */}" },
  rscParam: { start: "{/* RSC_PARAM_OUTPUT_START */}", end: "{/* RSC_PARAM_OUTPUT_END */}" },
  action: { start: "{/* ACTION_OUTPUT_START */}", end: "{/* ACTION_OUTPUT_END */}" },
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

async function captureRuntimeOutput(): Promise<{
  ssr: string;
  rsc: string;
  rscParam: string;
  action: string;
} | null> {
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

    // 1. Capture SSR output: initial page load
    stderr = "";
    console.log("Requesting SSR /about ...");
    await page.goto(`${BASE_URL}/about`);
    await waitForPattern(() => stderr, /\[flight\] SSR/);
    const ssrOutput = extractFlightBlock(stderr);

    // 2. Capture RSC output: client-side link click triggers RSC fetch
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    stderr = "";
    console.log("Clicking link to /about (RSC navigation) ...");
    await page.getByRole("link", { name: "About" }).first().click();
    await page.waitForSelector("h1:has-text('About')");
    await waitForPattern(() => stderr, /\[flight\] RSC/);
    const rscOutput = extractFlightBlock(stderr);

    // 3. Capture RSC output with dynamic route param (shows **** masking)
    await page.goto(`${BASE_URL}/posts`);
    await page.waitForLoadState("networkidle");
    stderr = "";
    console.log("Clicking link to /posts/:id (RSC with param) ...");
    // Click the first post link (post titles come from jsonplaceholder API)
    await page.locator('a[href^="/posts/"]').first().click();
    await page.waitForLoadState("networkidle");
    await waitForPattern(() => stderr, /\[flight\] RSC \/posts\/\*\*\*\*/);
    const rscParamOutput = extractFlightBlock(stderr);

    // 4. Capture ACTION output: fill form and submit
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("networkidle");
    stderr = "";
    console.log("Submitting message form (ACTION) ...");
    await page.fill('input[name="text"]', "hello from capture script");
    await page.getByRole("button", { name: "Send" }).click();
    await waitForPattern(() => stderr, /\[flight\] ACTION/, 10000);
    const actionOutput = extractFlightBlock(stderr);

    await browser.close();
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));

    return { ssr: ssrOutput, rsc: rscOutput, rscParam: rscParamOutput, action: actionOutput };
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

function injectIntoMarkdown(outputs: { ssr: string; rsc: string; action: string }): void {
  const md = readFileSync(targetFile, "utf-8");
  let updated = md;

  for (const [key, { start, end }] of Object.entries(MARKERS)) {
    const startIdx = updated.indexOf(start);
    const endIdx = updated.indexOf(end);
    if (startIdx === -1 || endIdx === -1) {
      console.warn(`Markers for ${key} not found in ${targetFile} — skipping`);
      continue;
    }
    const before = updated.slice(0, startIdx + start.length);
    const after = updated.slice(endIdx);
    const output = outputs[key as keyof typeof outputs];
    updated = `${before}\n\`\`\`\n${output}\n\`\`\`\n${after}`;
  }

  writeFileSync(targetFile, updated, "utf-8");
  console.log("Runtime output injected into debugging.mdx");
}

const output = await captureRuntimeOutput();
if (output) {
  injectIntoMarkdown(output);
} else {
  console.log("Skipping injection — using existing runtime output in docs.");
}
