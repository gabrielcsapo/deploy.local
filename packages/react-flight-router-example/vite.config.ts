import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { flightRouter } from "react-flight-router/dev";
import { apiPlugin } from "./app/api-plugin";
import { recordEvent } from "./app/lib/perf-store";

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify("1.0.0"),
  },
  plugins: [
    tailwindcss(),
    react(),
    apiPlugin(),
    flightRouter({
      routesFile: "./app/routes.ts",
      onRequest: (request) => {
        // Example: onRequest is still available for custom per-request setup.
        // getRequest() is populated automatically by the framework — this hook
        // is for additional context like logging or custom headers.
        console.log(`[onRequest] ${request.method} ${new URL(request.url).pathname}`);
      },
      onRequestComplete: (event) => {
        recordEvent(event);
      },
    }),
  ],
});
