import { serve } from "@hono/node-server";
import { createServer } from "flight-router/server";

async function main() {
  const app = await createServer({
    buildDir: "./dist",
  });

  serve({ fetch: app.fetch, port: 3000 }, (info) => {
    console.log(`Flight Router server running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
