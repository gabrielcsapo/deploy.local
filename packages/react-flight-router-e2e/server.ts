import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "react-flight-router/server";
import type { RequestTimingEvent } from "react-flight-router/server";

// Timing event store
const events: RequestTimingEvent[] = [];
const MAX_EVENTS = 1000;

// Worker mode controlled by WORKERS env var
const useWorkers = process.env.WORKERS === "1";
const workerConfig = useWorkers ? { size: 2 } : undefined;

async function main() {
  const flightApp = await createServer({
    buildDir: "./dist",
    workers: workerConfig,
    onRequest: (request) => {
      // Showcase how to set a custom header
      request.headers.set("x-custom-test", "hi");
    },
    onRequestComplete: (event) => {
      events.push(event);
      if (events.length > MAX_EVENTS) {
        events.splice(0, events.length - MAX_EVENTS);
      }
    },
  });

  const api = new Hono();

  // Health check — reports whether workers are enabled
  api.get("/api/health", (c) => {
    return c.json({
      ok: true,
      workers: useWorkers,
      workerSize: workerConfig?.size ?? 0,
      pid: process.pid,
    });
  });

  // Timing events API
  api.get("/api/timing", (c) => {
    const limit = Number(c.req.query("limit")) || 100;
    return c.json(events.slice(-limit));
  });

  api.delete("/api/timing", (c) => {
    events.length = 0;
    return c.json({ ok: true });
  });

  // Slow endpoint — blocks the event loop for the specified duration.
  // Used by e2e tests to simulate a CPU-bound action on the main thread.
  api.get("/api/slow", async (c) => {
    const delay = Number(c.req.query("delay")) || 1000;
    await new Promise((r) => setTimeout(r, delay));
    return c.json({ ok: true, delay, pid: process.pid });
  });

  const app = new Hono();
  app.route("/", api);
  app.route("/", flightApp);

  const port = Number(process.env.PORT) || 3002;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `E2E server running at http://localhost:${info.port} (workers: ${useWorkers ? `enabled (${workerConfig!.size})` : "disabled"})`,
    );
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
