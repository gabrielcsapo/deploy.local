import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { flightRouter } from "react-flight-router/dev";
import { apiPlugin } from "./app/api-plugin";
import { requestStorage } from "./app/lib/request-context";

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    apiPlugin(),
    flightRouter({
      routesFile: "./app/routes.ts",
      onRequest: (request) => {
        requestStorage.enterWith(request);
      },
    }),
  ],
});
