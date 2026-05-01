// Focused static-asset benchmark for /assets/* throughput.
// Boots the e2e server, hammers a real asset URL with autocannon,
// prints a summary block. Reusable for asset-handler optimizations.
//
// Usage:
//   node scripts/perf-static.mjs                   # runs against the built server
//   PORT=3010 CONNECTIONS=200 DURATION=10 node scripts/perf-static.mjs
//   ASSET=/assets/index-DOwEwm_z.js node scripts/perf-static.mjs

import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import autocannon from "autocannon";

const __filename = fileURLToPath(import.meta.url);
const PKG_DIR = resolve(dirname(__filename), "..");
const PORT = Number(process.env.PORT) || 3010;
const CONNECTIONS = Number(process.env.CONNECTIONS) || 100;
const DURATION = Number(process.env.DURATION) || 10;
const PIPELINING = Number(process.env.PIPELINING) || 1;

function pickAsset() {
  if (process.env.ASSET) return process.env.ASSET;
  const dir = resolve(PKG_DIR, "dist/client/assets");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  // Pick a mid-sized JS file (not the smallest, not the largest) for a realistic chunk
  files.sort();
  const pick = files[Math.floor(files.length / 2)];
  return `/assets/${pick}`;
}

function startServer() {
  return new Promise((resolveServer, reject) => {
    const proc = spawn("node", ["dist/server.js"], {
      cwd: PKG_DIR,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    const deadline = Date.now() + 15_000;
    const poll = async () => {
      try {
        const r = await fetch(`http://localhost:${PORT}/api/health`);
        if (r.ok) return resolveServer(proc);
      } catch {}
      if (Date.now() > deadline) {
        proc.kill();
        return reject(new Error(`server failed to start:\n${stderr}`));
      }
      setTimeout(poll, 100);
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
    }, 3_000);
  });
}

async function main() {
  const asset = pickAsset();
  console.log(`\n=== static-asset bench ===`);
  console.log(`url:        http://localhost:${PORT}${asset}`);
  console.log(`connections: ${CONNECTIONS}`);
  console.log(`duration:    ${DURATION}s`);
  console.log(`pipelining:  ${PIPELINING}\n`);

  const proc = await startServer();
  // Warm up the server for 1s
  await new Promise((r) => setTimeout(r, 1000));

  try {
    const result = await autocannon({
      url: `http://localhost:${PORT}${asset}`,
      connections: CONNECTIONS,
      duration: DURATION,
      pipelining: PIPELINING,
    });

    console.log(`requests/sec:  ${result.requests.average.toFixed(0)}`);
    console.log(`throughput:    ${(result.throughput.average / 1024 / 1024).toFixed(2)} MB/s`);
    console.log(`latency p50:   ${result.latency.p50.toFixed(2)} ms`);
    console.log(`latency p99:   ${result.latency.p99.toFixed(2)} ms`);
    console.log(`latency max:   ${result.latency.max.toFixed(2)} ms`);
    console.log(`2xx:           ${result["2xx"]}`);
    console.log(`non-2xx:       ${result.non2xx}`);
    console.log(`errors:        ${result.errors}`);
    console.log(`timeouts:      ${result.timeouts}`);
  } finally {
    await stopServer(proc);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
