import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createServer } from "react-flight-router/server";
import { recordEvent } from "./app/lib/perf-store";
import { app as apiApp } from "./app/api";

async function main() {
  const flightApp = await createServer({
    buildDir: "./dist",
    onRequest: (request) => {
      // Example: onRequest is still available for custom per-request setup.
      // getRequest() is populated automatically by the framework — this hook
      // is for additional context like logging or custom headers.
      console.log(`[onRequest] ${request.method} ${new URL(request.url).pathname}`);
    },
    onRequestComplete: (event) => {
      recordEvent(event);
    },
  });

  const app = new Hono();

  // API routes (mounted before flight router catch-all)
  app.route("/", apiApp);

  // Flight router (handles RSC, SSR, static assets, and catch-all)
  app.route("/", flightApp);

  const port = Number(process.env.PORT) || 3000;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`React Flight Router server running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
