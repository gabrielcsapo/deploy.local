// Cold-start RSC timing harness.
// For each iteration:
//   1. Spawn a fresh server (cold module cache)
//   2. Wait for /api/health
//   3. Issue a single GET to a target RSC URL
//   4. Read /api/timing for the structured timing event
//   5. Kill the server
// Then summarizes mean/median/p99 of selected labels.
//
// Usage:
//   node scripts/perf-rsc-cold.mjs                          # default: /boundary-page, 30 iters
//   ITERS=50 TARGET=/boundary-page node scripts/perf-rsc-cold.mjs
//   FLIGHT_DEBUG=1 ITERS=3 node scripts/perf-rsc-cold.mjs   # also prints per-iter timings

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const PKG_DIR = resolve(dirname(__filename), "..");
const ITERS = Number(process.env.ITERS) || 30;
const TARGET = process.env.TARGET || "/boundary-page";
const BASE_PORT = Number(process.env.PORT) || 3020;

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
    // Drain any timing events from server warm-up requests
    await fetch(`http://localhost:${port}/api/timing`, { method: "DELETE" });

    // Issue the cold RSC request
    const url = `http://localhost:${port}/__rsc?url=${encodeURIComponent(TARGET)}`;
    const t0 = performance.now();
    const r = await fetch(url);
    // Drain the body so onRequestComplete fires
    await r.arrayBuffer();
    const wallMs = performance.now() - t0;

    // Pull the structured timing event
    const eventsRes = await fetch(`http://localhost:${port}/api/timing?limit=10`);
    const events = await eventsRes.json();
    // Most recent event first; should be the RSC one we just issued
    const event = events[events.length - 1];
    return { wallMs, event };
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

async function main() {
  console.log(`\n=== cold-start RSC timing ===`);
  console.log(`target: ${TARGET}`);
  console.log(`iters:  ${ITERS}\n`);

  const wallTimes = [];
  const totalTimes = [];
  const labelTimes = new Map(); // label → number[]

  for (let i = 0; i < ITERS; i++) {
    const port = BASE_PORT + (i % 5); // rotate across a few ports to avoid TIME_WAIT collisions
    let result;
    try {
      result = await singleColdRun(port);
    } catch (err) {
      console.error(`iter ${i}: ${err.message}`);
      continue;
    }

    const { wallMs, event } = result;
    wallTimes.push(wallMs);
    if (event) {
      totalTimes.push(event.totalMs);
      for (const t of event.timings ?? []) {
        if (t.durationMs == null) continue;
        if (!labelTimes.has(t.label)) labelTimes.set(t.label, []);
        labelTimes.get(t.label).push(t.durationMs);
      }
      if (process.env.FLIGHT_DEBUG === "1") {
        console.log(
          `iter ${i}: wall=${wallMs.toFixed(2)}ms total=${event.totalMs.toFixed(2)}ms ` +
            (event.timings ?? [])
              .filter((t) => t.durationMs != null)
              .map((t) => `${t.label}=${t.durationMs.toFixed(2)}`)
              .join(" "),
        );
      }
    }
    process.stdout.write(".");
  }
  console.log("\n");

  const fmt = (arr) =>
    arr.length === 0
      ? "—"
      : `mean=${mean(arr).toFixed(2)}ms  median=${pct(arr, 50).toFixed(2)}ms  p99=${pct(arr, 99).toFixed(2)}ms`;

  console.log(`wall (client-observed): ${fmt(wallTimes)}`);
  console.log(`total (server logger):  ${fmt(totalTimes)}`);
  console.log("");
  console.log("per-label (in render):");
  // Sort labels by mean duration descending so the slowest are first
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
