import { serve } from "@hono/node-server";
import { createServer } from "react-flight-router/server";

async function main() {
  const app = await createServer({
    buildDir: "./dist",
  });

  const port = Number(process.env.PORT) || 3000;
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`React Flight Router server running at http://localhost:${info.port}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
