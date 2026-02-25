import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

async function main() {
  const app = await createServer({
    buildDir: "./dist",
  });

  serve({ fetch: app.fetch, port: 3001 }, (info) => {
    console.log(`Notes app running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
