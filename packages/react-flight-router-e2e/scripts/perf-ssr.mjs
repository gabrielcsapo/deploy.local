// SSR bench harness. Measures both:
//   - TTFB (time to first byte of HTML)
//   - Total time (response fully consumed)
// for a target route. The TTFB number is the one that exposes streaming
// regressions — if SSR has to fully buffer the RSC stream before it can
// begin, TTFB approaches total time. If it streams, TTFB ≈ shell render time.
//
// Usage:
//   node scripts/perf-ssr.mjs                 # default: /boundary-page, 30 iters
//   ITERS=50 TARGET=/ node scripts/perf-ssr.mjs

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PKG_DIR = resolve(dirname(__filename), "..");
const ITERS = Number(process.env.ITERS) || 30;
const TARGET = process.env.TARGET || "/boundary-page";
const BASE_PORT = Number(process.env.PORT) || 3030;

function startServer(port) {
  return new Promise((resolveServer, reject) => {
    const proc = spawn("node", ["dist/server.js"], {
      cwd: PKG_DIR,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    const deadline = Date.now() + 15_000;
    const poll = async () => {
      try {
        const r = await fetch(`http://localhost:${port}/api/health`);
        if (r.ok) return resolveServer(proc);
      } catch {}
      if (Date.now() > deadline) {
        proc.kill();
        return reject(new Error(`server failed to start:\n${stderr}`));
      }
      setTimeout(poll, 50);
    };
    poll();
  });
}

function stopServer(proc) {
  return new Promise((res) => {
    proc.once("exit", () => res());
    proc.kill("SIGTERM");
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      res();
    }, 2_000);
  });
}

async function singleColdRun(port) {
  const proc = await startServer(port);
  try {
    await fetch(`http://localhost:${port}/api/timing`, { method: "DELETE" });

    const url = `http://localhost:${port}${TARGET}`;
    const t0 = performance.now();
    const r = await fetch(url);

    // Read first chunk to capture TTFB (time until response.body produces any bytes)
    const reader = r.body.getReader();
    const first = await reader.read();
    const ttfbMs = performance.now() - t0;

    // Drain the rest
    let totalBytes = first.value ? first.value.byteLength : 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
    }
    const totalMs = performance.now() - t0;

    // Server-side timing event (populated via onRequestComplete)
    const eventsRes = await fetch(`http://localhost:${port}/api/timing?limit=10`);
    const events = await eventsRes.json();
    const event = events[events.length - 1];

    return { ttfbMs, totalMs, totalBytes, event };
  } finally {
    await stopServer(proc);
  }
}

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[idx];
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function fmt(arr) {
  return arr.length === 0
    ? "—"
    : `mean=${mean(arr).toFixed(2)}ms  median=${pct(arr, 50).toFixed(2)}ms  p99=${pct(arr, 99).toFixed(2)}ms`;
}

async function main() {
  console.log(`\n=== cold-start SSR timing ===`);
  console.log(`target: ${TARGET}`);
  console.log(`iters:  ${ITERS}\n`);

  const ttfb = [];
  const total = [];
  const totalBytes = [];
  const labelTimes = new Map();

  for (let i = 0; i < ITERS; i++) {
    const port = BASE_PORT + (i % 5);
    let result;
    try {
      result = await singleColdRun(port);
    } catch (err) {
      console.error(`iter ${i}: ${err.message}`);
      continue;
    }
    ttfb.push(result.ttfbMs);
    total.push(result.totalMs);
    totalBytes.push(result.totalBytes);
    if (result.event) {
      for (const t of result.event.timings ?? []) {
        if (t.durationMs == null) continue;
        if (!labelTimes.has(t.label)) labelTimes.set(t.label, []);
        labelTimes.get(t.label).push(t.durationMs);
      }
    }
    process.stdout.write(".");
  }
  console.log("\n");

  console.log(`TTFB:           ${fmt(ttfb)}`);
  console.log(`total wall:     ${fmt(total)}`);
  console.log(
    `bytes/response: mean=${(mean(totalBytes) / 1024).toFixed(2)} KB  p99=${(pct(totalBytes, 99) / 1024).toFixed(2)} KB`,
  );
  console.log("");
  console.log("server-side per-label:");
  const labelStats = [...labelTimes.entries()]
    .map(([label, arr]) => ({ label, mean: mean(arr), arr }))
    .sort((a, b) => b.mean - a.mean);
  for (const { label, arr } of labelStats) {
    console.log(`  ${label.padEnd(28)} ${fmt(arr)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
