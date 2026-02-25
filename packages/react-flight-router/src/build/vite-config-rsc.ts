import { resolve, dirname } from "path";
import { createRequire } from "module";
import type { InlineConfig, Plugin } from "vite";
import { useClientPlugin, getModuleId } from "./plugin-use-client.js";
import { useServerPlugin } from "./plugin-use-server.js";
import { collectClientModulesPlugin } from "./plugin-collect-client-modules.js";

const RSC_RUNTIME_ID = "virtual:rsc-runtime";

/**
 * Maps React package imports to their react-server variant files.
 * Vite's resolve.conditions doesn't reliably apply to CJS require()
 * calls inside bundled packages, so we redirect explicitly.
 */
const REACT_SERVER_FILE_MAP: Record<string, string> = {
  react: "react.react-server.js",
  "react/jsx-runtime": "jsx-runtime.react-server.js",
  "react/jsx-dev-runtime": "jsx-dev-runtime.react-server.js",
};

/**
 * Plugin that bundles a virtual RSC runtime entry and resolves React
 * to its react-server variant. This allows the production server to
 * use renderToReadableStream without --conditions=react-server.
 */
function rscRuntimePlugin(): Plugin {
  return {
    name: "react-flight-router:rsc-runtime",
    enforce: "pre",
    async resolveId(id) {
      if (id === RSC_RUNTIME_ID) return id;

      // Redirect react imports to react-server variant files.
      // Use createRequire to get absolute paths — Vite's SSR auto-externalization
      // ignores noExternal and this.resolve returns { external: true } for bare
      // specifiers, so we must resolve manually.
      const serverFile = REACT_SERVER_FILE_MAP[id];
      if (serverFile) {
        try {
          const require = createRequire(import.meta.url);
          const resolved = require.resolve(id);
          const dir = dirname(resolved);
          return { id: resolve(dir, serverFile), external: false };
        } catch {
          // Fall through to default resolution
        }
      }
    },
    load(id) {
      if (id === RSC_RUNTIME_ID) {
        // Resolve to an absolute path so Vite treats it as a local file
        // and bundles it instead of externalizing the bare specifier.
        const require = createRequire(import.meta.url);
        const absPath = require.resolve("react-server-dom-webpack/server.node");
        return `export { renderToReadableStream, decodeReply, registerClientReference, registerServerReference } from ${JSON.stringify(absPath)};`;
      }
    },
  };
}

interface RSCBuildOptions {
  appDir: string;
  outDir: string;
  routesEntry: string;
  /** Pre-scanned 'use server' module paths to include as entries */
  serverActionEntries?: string[];
  /** Additional packages to externalize (e.g., native modules) */
  external?: string[];
}

export function createRSCServerConfig(opts: RSCBuildOptions) {
  const clientCollector = collectClientModulesPlugin();
  const serverModules = new Set<string>();

  const config: InlineConfig = {
    configFile: false,
    // Force production mode so CJS react-server entry files
    // (which check process.env.NODE_ENV) load the production build.
    // Mismatched dev server + prod client causes Flight protocol errors.
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    resolve: {
      conditions: ["react-server", "node", "import"],
    },
    ssr: {
      // Bundle everything by default so that resolve.conditions: ['react-server']
      // applies at build time. Packages that should remain external are specified
      // in rollupOptions.external below.
      noExternal: true,
    },
    build: {
      ssr: true,
      outDir: resolve(opts.outDir, "server"),
      emptyOutDir: false,
      rollupOptions: {
        input: {
          "rsc-entry": opts.routesEntry,
          "rsc-runtime": RSC_RUNTIME_ID,
          // Include pre-scanned 'use server' modules as entries so they're
          // processed even if only imported by client components (which get
          // replaced with registerClientReference proxies in RSC mode).
          ...Object.fromEntries(
            (opts.serverActionEntries ?? []).map((f) => [
              `server-action-${getModuleId(f).replace(/\//g, "-")}`,
              f,
            ]),
          ),
        },
        external: [
          "react-dom",
          "react-dom/server",
          "hono",
          "@hono/node-server",
          "react-flight-router/server",
          "react-flight-router/router",
          ...(opts.external ?? []),
        ],
        output: {
          format: "esm" as const,
          entryFileNames: "[name].js",
          chunkFileNames: "chunks/[name]-[hash].js",
        },
      },
      minify: false,
    },
    plugins: [
      rscRuntimePlugin(),
      useClientPlugin({
        mode: "rsc-server",
        onClientModule: (id) => clientCollector.collectedModules.add(id),
      }),
      useServerPlugin({
        mode: "rsc-server",
        onServerModule: (id) => serverModules.add(id),
      }),
      clientCollector,
    ],
  };

  return {
    config,
    getClientModules: () => clientCollector.collectedModules,
    getServerModules: () => serverModules,
  };
}
