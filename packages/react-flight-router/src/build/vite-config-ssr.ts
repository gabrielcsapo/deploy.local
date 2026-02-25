import { resolve } from "path";
import type { InlineConfig } from "vite";
import { useServerPlugin } from "./plugin-use-server.js";
import { getModuleId } from "./plugin-use-client.js";

interface SSRBuildOptions {
  appDir: string;
  outDir: string;
  clientModules: Set<string>;
}

export function createSSRConfig(opts: SSRBuildOptions): InlineConfig {
  const ssrEntries: Record<string, string> = {};

  for (const mod of opts.clientModules) {
    const id = getModuleId(mod);
    ssrEntries[id] = mod;
  }

  return {
    configFile: false,
    build: {
      ssr: true,
      outDir: resolve(opts.outDir, "server/ssr"),
      emptyOutDir: true,
      rollupOptions: {
        input: ssrEntries,
        external: [
          "react",
          "react/jsx-runtime",
          "react/jsx-dev-runtime",
          "react-dom",
          "react-dom/server",
          "react-server-dom-webpack/client.node",
          "react-server-dom-webpack/client",
          "react-server-dom-webpack/client.browser",
          "hono",
          "@hono/node-server",
          "react-flight-router",
          "react-flight-router/server",
          // NOTE: "react-flight-router/client" is intentionally NOT externalized.
          // App client components (e.g., nav.client.tsx) import Link/useRouter from
          // this path. If externalized, Node.js resolves to the npm package's modules
          // which are different instances from the SSR bundle's copies. This breaks
          // React context sharing (RouterContext) between the SSR RouterProvider and
          // the SSR Link/Outlet components. By bundling it, Vite deduplicates imports
          // with the SSR build entries, ensuring a single RouterContext instance.
          "react-flight-router/router",
        ],
        output: {
          format: "esm" as const,
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
      minify: false,
    },
    plugins: [useServerPlugin({ mode: "ssr" })],
  };
}
