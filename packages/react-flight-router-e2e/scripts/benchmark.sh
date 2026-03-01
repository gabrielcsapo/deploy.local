#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
ARTILLERY="npx artillery"
REPORT_DIR="$PKG_DIR/benchmark-results"

NO_WORKER_PORT=3010
WORKER_PORT=3011

mkdir -p "$REPORT_DIR"

echo "================================================"
echo " React Flight Router — Worker Benchmark"
echo "================================================"
echo ""

# Build if needed
if [ ! -f "$PKG_DIR/dist/server.js" ]; then
  echo "Building the app..."
  cd "$PKG_DIR" && npm run build
  echo ""
fi

# Helper: start server and wait for it
start_server() {
  local port=$1
  local workers=$2
  local label=$3

  echo "Starting $label server on port $port..." >&2
  if [ "$workers" = "1" ]; then
    WORKERS=1 PORT=$port node "$PKG_DIR/dist/server.js" > /dev/null 2>&1 &
  else
    PORT=$port node "$PKG_DIR/dist/server.js" > /dev/null 2>&1 &
  fi
  local pid=$!

  # Wait for server
  local deadline=$((SECONDS + 15))
  while [ $SECONDS -lt $deadline ]; do
    if curl -s "http://localhost:$port/api/health" > /dev/null 2>&1; then
      echo "  Server ready (PID $pid)" >&2
      echo "$pid"
      return 0
    fi
    sleep 0.2
  done
  echo "  ERROR: Server failed to start!" >&2
  kill $pid 2>/dev/null || true
  return 1
}

# Helper: stop server
stop_server() {
  local pid=$1
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
}

# Helper: run artillery and save JSON report
run_artillery() {
  local config=$1
  local port=$2
  local output=$3

  PORT=$port $ARTILLERY run \
    --output "$output" \
    "$config"
}

echo ""
echo "--- Phase 1: No Workers (baseline) ---"
echo ""

NO_WORKER_PID=$(start_server $NO_WORKER_PORT 0 "no-workers")

echo "  Running mixed load test (30s)..."
run_artillery "$PKG_DIR/artillery/mixed-load.yml" $NO_WORKER_PORT "$REPORT_DIR/no-workers-mixed.json"

echo "  Running actions-only load test (30s)..."
run_artillery "$PKG_DIR/artillery/actions-load.yml" $NO_WORKER_PORT "$REPORT_DIR/no-workers-actions.json"

echo "  Running pages-during-load test (30s)..."
run_artillery "$PKG_DIR/artillery/pages-during-load.yml" $NO_WORKER_PORT "$REPORT_DIR/no-workers-pages.json"

stop_server "$NO_WORKER_PID"
echo "  Baseline server stopped."

echo ""
echo "--- Phase 2: With Workers ---"
echo ""

WORKER_PID=$(start_server $WORKER_PORT 1 "workers")

echo "  Running mixed load test (30s)..."
run_artillery "$PKG_DIR/artillery/mixed-load.yml" $WORKER_PORT "$REPORT_DIR/workers-mixed.json"

echo "  Running actions-only load test (30s)..."
run_artillery "$PKG_DIR/artillery/actions-load.yml" $WORKER_PORT "$REPORT_DIR/workers-actions.json"

echo "  Running pages-during-load test (30s)..."
run_artillery "$PKG_DIR/artillery/pages-during-load.yml" $WORKER_PORT "$REPORT_DIR/workers-pages.json"

stop_server "$WORKER_PID"
echo "  Workers server stopped."

echo ""
echo "--- Results ---"
echo ""

# Generate comparison table using a heredoc to avoid shell escaping issues
node --input-type=module - "$REPORT_DIR" <<'REPORT_SCRIPT'
import { readFileSync } from "fs";

const dir = process.argv[2];

function loadReport(path) {
  try {
    const r = JSON.parse(readFileSync(path, "utf8"));
    const agg = r.aggregate;
    if (!agg) return null;
    const lat = agg.summaries?.["http.response_time"] || {};
    return {
      p50: lat.median ?? lat.p50 ?? "N/A",
      p95: lat.p95 ?? "N/A",
      p99: lat.p99 ?? "N/A",
      codes200: agg.counters?.["http.codes.200"] ?? 0,
      errors: agg.counters?.["vusers.failed"] ?? 0,
    };
  } catch { return null; }
}

function fmt(v) {
  if (v === "N/A" || v === null || v === undefined) return "N/A";
  return typeof v === "number" ? v.toFixed(1) : String(v);
}

function imp(b, i) {
  b = Number(b); i = Number(i);
  if (isNaN(b) || isNaN(i) || b === 0) return "";
  const p = ((b - i) / b * 100);
  return (p > 0 ? "-" : "+") + Math.abs(p).toFixed(0) + "%";
}

const tests = [
  { name: "Mixed Load",  nw: dir + "/no-workers-mixed.json",   w: dir + "/workers-mixed.json" },
  { name: "Actions Only", nw: dir + "/no-workers-actions.json", w: dir + "/workers-actions.json" },
  { name: "Pages Only",  nw: dir + "/no-workers-pages.json",   w: dir + "/workers-pages.json" },
];

console.log("| Test          | Metric       | No Workers | Workers  | Change |");
console.log("|---------------|--------------|------------|----------|--------|");

for (const t of tests) {
  const nw = loadReport(t.nw) || { p50: "N/A", p95: "N/A", p99: "N/A", codes200: 0, errors: 0 };
  const w = loadReport(t.w) || { p50: "N/A", p95: "N/A", p99: "N/A", codes200: 0, errors: 0 };

  console.log(`| ${t.name.padEnd(13)} | p50 (ms)     | ${fmt(nw.p50).padStart(10)} | ${fmt(w.p50).padStart(8)} | ${imp(nw.p50, w.p50).padStart(6)} |`);
  console.log(`|               | p95 (ms)     | ${fmt(nw.p95).padStart(10)} | ${fmt(w.p95).padStart(8)} | ${imp(nw.p95, w.p95).padStart(6)} |`);
  console.log(`|               | p99 (ms)     | ${fmt(nw.p99).padStart(10)} | ${fmt(w.p99).padStart(8)} | ${imp(nw.p99, w.p99).padStart(6)} |`);
  console.log(`|               | Requests OK  | ${String(nw.codes200).padStart(10)} | ${String(w.codes200).padStart(8)} |        |`);
  console.log(`|               | Errors       | ${String(nw.errors).padStart(10)} | ${String(w.errors).padStart(8)} |        |`);
}

console.log("");
console.log("Reports saved to: " + dir);
REPORT_SCRIPT

echo ""
echo "Done! Full Artillery JSON reports are in:"
echo "  $REPORT_DIR/"
