import { resolve, dirname } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import { build as viteBuild, loadConfigFromFile } from "vite";
import react from "@vitejs/plugin-react";
import { createRSCServerConfig } from "./vite-config-rsc.js";
import { createClientConfig } from "./vite-config-client.js";
import { createSSRConfig } from "./vite-config-ssr.js";
import { generateManifests } from "./manifest-generator.js";
import {
  type RollupOutput,
  parseRoutes,
  flattenRoutes,
  resolveRouteClientModules,
  computeRouteSizes,
  mapServerChunksToRoutes,
  printHeader,
  printRouteTable,
  printSharedChunks,
  printLegend,
  printModuleCounts,
  printPhase,
  printBuildStart,
  printOutputSummary,
} from "./build-format.js";

interface BuildOptions {
  /** Root directory of the app (where app/ lives) */
  appRoot: string;
  /** Output directory for the build */
  outDir?: string;
  /** Path to the routes file */
  routesFile?: string;
  /** Path to the client entry file */
  clientEntry?: string;
  /** Path to the server entry file (compiled to dist/server.js) */
  serverEntry?: string;
}

function readPackageVersion(): string {
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dirname, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function build(opts: BuildOptions): Promise<void> {
  const appRoot = resolve(opts.appRoot);
  const outDir = resolve(opts.outDir ?? "dist");
  const routesEntry = resolve(appRoot, opts.routesFile ?? "app/routes.ts");
  const clientEntry = resolve(
    appRoot,
    opts.clientEntry ?? "node_modules/react-flight-router/dist/client/entry.js",
  );

  const buildStart = performance.now();

  // Print header
  const version = readPackageVersion();
  printHeader(version);

  // Parse routes for display
  const parsedRoutes = await parseRoutes(routesEntry);
  const routesDir = dirname(routesEntry);

  // Load the app's vite.config to pick up user-configured plugins (e.g., Tailwind).
  // We filter out plugins we add ourselves (React, react-flight-router).
  const appPlugins = await loadAppPlugins(appRoot);

  // Scan for CSS files imported in the app (e.g., `import './styles.css'`).
  // These need to be included in the client build since server components
  // don't produce client-side CSS.
  const cssEntries = scanForCSSImports(appRoot);

  // Pre-scan: discover 'use server' modules that may only be imported by client
  // components (which get replaced in RSC mode, hiding their imports).
  const serverActionEntries = scanForServerModules(appRoot);

  // Detect native modules that can't be bundled (e.g., better-sqlite3)
  const nativeModules = detectNativeModules(appRoot);

  // Phase 1: RSC Server Build
  printBuildStart();
  let phaseStart = performance.now();
  const rscConfig = createRSCServerConfig({
    appDir: appRoot,
    outDir,
    routesEntry,
    serverActionEntries,
    external: nativeModules,
  });
  rscConfig.config.logLevel = "silent";

  // Add app plugins (e.g., Tailwind) so CSS imports in server components resolve correctly
  rscConfig.config.plugins = [...(rscConfig.config.plugins ?? []), ...appPlugins];

  const rscOutput = (await viteBuild(rscConfig.config)) as RollupOutput;

  const clientModules = rscConfig.getClientModules();
  const serverModules = rscConfig.getServerModules();
  printPhase(1, "RSC server", performance.now() - phaseStart);

  // Phase 2: Client Build
  phaseStart = performance.now();
  const clientConfig = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules,
    clientEntryPath: clientEntry,
    cssEntries,
  });
  clientConfig.logLevel = "silent";

  // Add React plugin + app plugins (e.g., Tailwind) for the client build
  clientConfig.plugins = [react(), ...appPlugins, ...(clientConfig.plugins ?? [])];

  await viteBuild(clientConfig);
  printPhase(2, "Client bundle", performance.now() - phaseStart);

  // Phase 3: SSR Build
  phaseStart = performance.now();
  const ssrConfig = createSSRConfig({
    appDir: appRoot,
    outDir,
    clientModules,
  });
  ssrConfig.logLevel = "silent";

  ssrConfig.plugins = [react(), ...(ssrConfig.plugins ?? [])];

  await viteBuild(ssrConfig);
  printPhase(3, "SSR bundle", performance.now() - phaseStart);

  // Phase 4: Generate manifests
  phaseStart = performance.now();
  generateManifests({
    outDir,
    clientModules,
    serverModules,
  });
  printPhase(4, "Manifests", performance.now() - phaseStart);

  // Phase 5: Build server entry
  const serverEntryPath = resolve(appRoot, opts.serverEntry ?? "server.ts");
  if (existsSync(serverEntryPath)) {
    phaseStart = performance.now();
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      build: {
        ssr: true,
        outDir,
        emptyOutDir: false,
        rollupOptions: {
          input: { server: serverEntryPath },
          external: [
            "react",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "react-dom",
            "react-dom/server",
            "react-dom/client",
            "react-server-dom-webpack/client.node",
            "hono",
            "@hono/node-server",
            "react-flight-router",
            "react-flight-router/server",
            "react-flight-router/client",
            "react-flight-router/router",
            ...nativeModules,
          ],
          output: {
            format: "esm" as const,
            entryFileNames: "[name].js",
          },
        },
        minify: false,
      },
    });
    printPhase(5, "Server entry", performance.now() - phaseStart);
  }

  console.log("");

  // Route analysis: compute per-route sizes
  if (parsedRoutes.length > 0) {
    const routeClientModules = resolveRouteClientModules(parsedRoutes, routesDir, clientModules);

    const sizeData = computeRouteSizes(outDir, routeClientModules, rscOutput, clientModules);

    const serverSizes = mapServerChunksToRoutes(parsedRoutes, routesDir, rscOutput);

    const flatRoutes = flattenRoutes(parsedRoutes);

    printRouteTable(flatRoutes, sizeData, serverSizes);
    printSharedChunks(sizeData);
    printLegend();
  }

  printModuleCounts(clientModules.size, serverModules.size, cssEntries.length);

  // Final output summary
  const totalDuration = performance.now() - buildStart;
  printOutputSummary(outDir, totalDuration);
}

/**
 * Load the app's vite.config.ts and extract plugins, filtering out
 * plugins we add ourselves (React, react-flight-router).
 */
async function loadAppPlugins(appRoot: string): Promise<any[]> {
  try {
    const result = await loadConfigFromFile(
      { command: "build", mode: "production" },
      undefined, // auto-detect config file
      appRoot,
    );
    if (!result?.config.plugins) return [];

    const skipNames = new Set([
      "vite:react-babel",
      "vite:react-jsx",
      "vite:react-refresh",
      "react-flight-router",
      "react-flight-router:rsc",
    ]);

    return result.config.plugins
      .flat()
      .filter(
        (p): p is any =>
          p != null && typeof p === "object" && "name" in p && !skipNames.has((p as any).name),
      );
  } catch {
    return [];
  }
}

/**
 * Scan the app directory for CSS files that are imported by app modules.
 * CSS imported in server components doesn't get extracted to the client build,
 * so we need to add these as explicit entries.
 */
function scanForCSSImports(appRoot: string): string[] {
  const appDir = resolve(appRoot, "app");
  if (!existsSync(appDir)) return [];

  const cssFiles: string[] = [];
  const entries = readdirSync(appDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    const fullPath = resolve(entry.parentPath, entry.name);
    const content = readFileSync(fullPath, "utf-8");

    // Match: import './styles.css' or import '../foo.css' etc.
    const cssImportPattern = /import\s+['"]([^'"]+\.css)['"]/g;
    let match;
    while ((match = cssImportPattern.exec(content)) !== null) {
      const cssPath = resolve(entry.parentPath, match[1]);
      if (existsSync(cssPath) && !cssFiles.includes(cssPath)) {
        cssFiles.push(cssPath);
      }
    }
  }

  return cssFiles;
}

/**
 * Scan the app directory for files containing 'use server' directive.
 * This catches server action modules that are only imported by client components
 * (which get replaced in the RSC build, hiding their server action imports).
 */
function scanForServerModules(appRoot: string): string[] {
  const appDir = resolve(appRoot, "app");
  if (!existsSync(appDir)) return [];

  const serverModules: string[] = [];
  const entries = readdirSync(appDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    const fullPath = resolve(entry.parentPath, entry.name);
    const content = readFileSync(fullPath, "utf-8");

    if (/^['"]use server['"];?/m.test(content.trimStart())) {
      serverModules.push(fullPath);
    }
  }

  return serverModules;
}

/**
 * Detect dependencies with native Node.js addons that can't be bundled.
 * Checks for common indicators: install scripts using node-gyp/prebuild,
 * gypfile flag, or binary field in package.json.
 */
function detectNativeModules(appRoot: string): string[] {
  const pkgPath = resolve(appRoot, "package.json");
  if (!existsSync(pkgPath)) return [];

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  const native: string[] = [];

  for (const dep of deps) {
    try {
      const depPkgPath = resolve(appRoot, "node_modules", dep, "package.json");
      if (!existsSync(depPkgPath)) continue;
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf-8"));

      const installScript = depPkg.scripts?.install ?? "";
      if (
        depPkg.gypfile ||
        depPkg.binary ||
        installScript.includes("node-gyp") ||
        installScript.includes("prebuild-install") ||
        installScript.includes("node-pre-gyp")
      ) {
        native.push(dep);
      }
    } catch {
      // Skip packages we can't read
    }
  }

  return native;
}
