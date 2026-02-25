import { resolve } from "path";
import type { InlineConfig } from "vite";
import { useServerPlugin } from "./plugin-use-server.js";
import { getModuleId } from "./plugin-use-client.js";

interface ClientBuildOptions {
  appDir: string;
  outDir: string;
  clientModules: Set<string>;
  clientEntryPath: string;
  /** CSS files to include in the client build (discovered from app imports) */
  cssEntries?: string[];
}

export function createClientConfig(opts: ClientBuildOptions): InlineConfig {
  // Each client component file becomes an entry for code splitting
  const clientEntries: Record<string, string> = {
    "entry-client": opts.clientEntryPath,
  };

  for (const mod of opts.clientModules) {
    const id = getModuleId(mod);
    clientEntries[id] = mod;
  }

  // Add CSS entries so they get processed and extracted in the client build.
  // CSS imported in server components doesn't get extracted, so we add them
  // explicitly here.
  if (opts.cssEntries) {
    for (const cssPath of opts.cssEntries) {
      const name = cssPath.replace(/.*\/app\//, "app/").replace(/\.css$/, "");
      clientEntries[name] = cssPath;
    }
  }

  return {
    configFile: false,
    resolve: {
      // Deduplicate React packages so all entries (client entry from
      // react-flight-router + app client components) share one instance.
      // Without this, pnpm's strict dependency isolation causes Rollup to
      // bundle two separate React copies (one per node_modules tree).
      dedupe: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    build: {
      outDir: resolve(opts.outDir, "client"),
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        input: clientEntries,
        // Client component modules are loaded at runtime via __webpack_require__,
        // so Rollup can't see their usage and would tree-shake their exports.
        preserveEntrySignatures: "exports-only",
        output: {
          format: "esm" as const,
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash].[ext]",
        },
      },
      minify: true,
    },
    plugins: [useServerPlugin({ mode: "client" })],
  };
}
