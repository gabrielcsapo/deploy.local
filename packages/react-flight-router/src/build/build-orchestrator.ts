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
  validateRouteComponents,
  printRouteValidationErrors,
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
  // Resolve the client entry relative to this package's own dist directory,
  // so it works regardless of node_modules layout (pnpm workspaces, symlinks, hoisting)
  let clientEntry: string;
  if (opts.clientEntry) {
    clientEntry = resolve(appRoot, opts.clientEntry);
  } else {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    clientEntry = resolve(__dirname, "../client/entry.js");
  }

  const buildStart = performance.now();

  // Print header
  const version = readPackageVersion();
  printHeader(version);

  // Parse routes for display and validation
  const parsedRoutes = await parseRoutes(routesEntry);
  const routesDir = dirname(routesEntry);

  // Validate that route components are not "use client" — they must be server components
  if (parsedRoutes.length > 0) {
    const validationErrors = validateRouteComponents(parsedRoutes, routesDir);
    if (validationErrors.length > 0) {
      printRouteValidationErrors(validationErrors);
      throw new Error(
        `Build failed: ${validationErrors.length} route component(s) have "use client" directive. ` +
          `Route components must be server components.`,
      );
    }
  }

  // Load the app's vite.config to pick up user-configured plugins (e.g., Tailwind)
  // and resolve config (e.g., path aliases like @/).
  // We filter out plugins we add ourselves (React, react-flight-router).
  const appConfig = await loadAppConfig(appRoot);
  const appPlugins = appConfig.plugins;

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
    external: [...nativeModules, ...(appConfig.ssrExternal ?? [])],
  });
  rscConfig.config.logLevel = "silent";

  // Add app plugins (e.g., Tailwind) so CSS imports in server components resolve correctly
  rscConfig.config.plugins = [...(rscConfig.config.plugins ?? []), ...appPlugins];
  // Forward resolve config (e.g., path aliases like @/) from the user's vite.config
  if (appConfig.resolve) {
    rscConfig.config.resolve = { ...rscConfig.config.resolve, ...appConfig.resolve };
  }
  // Forward user-defined globals (e.g., __APP_VERSION__), merging with the RSC
  // build's own defines (process.env.NODE_ENV) so neither set is lost.
  if (appConfig.define) {
    rscConfig.config.define = { ...appConfig.define, ...rscConfig.config.define };
  }

  const rscOutput = (await viteBuild(rscConfig.config)) as RollupOutput;

  const clientModules = rscConfig.getClientModules();
  const serverModules = rscConfig.getServerModules();
  printPhase(1, "RSC server", performance.now() - phaseStart);

  // Phase 2: Client and SSR builds run in parallel.
  // Both depend only on Phase 1 output (clientModules).
  const parallelStart = performance.now();

  const clientConfig = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules,
    clientEntryPath: clientEntry,
    cssEntries,
  });
  clientConfig.logLevel = "silent";
  clientConfig.plugins = [react(), ...appPlugins, ...(clientConfig.plugins ?? [])];
  if (appConfig.resolve) {
    clientConfig.resolve = { ...clientConfig.resolve, ...appConfig.resolve };
  }
  if (appConfig.define) {
    clientConfig.define = { ...appConfig.define, ...clientConfig.define };
  }

  const ssrConfig = createSSRConfig({
    appDir: appRoot,
    outDir,
    clientModules,
  });
  ssrConfig.logLevel = "silent";
  ssrConfig.plugins = [react(), ...(ssrConfig.plugins ?? [])];
  if (appConfig.resolve) {
    ssrConfig.resolve = { ...ssrConfig.resolve, ...appConfig.resolve };
  }
  if (appConfig.define) {
    ssrConfig.define = { ...appConfig.define, ...ssrConfig.define };
  }

  await Promise.all([viteBuild(clientConfig), viteBuild(ssrConfig)]);
  printPhase(2, "Client + SSR (parallel)", performance.now() - parallelStart);

  // Phase 3: Generate manifests (depends on client build output)
  phaseStart = performance.now();
  generateManifests({
    outDir,
    appDir: appRoot,
    clientModules,
    serverModules,
  });
  printPhase(3, "Manifests", performance.now() - phaseStart);

  // Phase 4: Build server entry
  const serverEntryPath = resolve(appRoot, opts.serverEntry ?? "server.ts");
  if (existsSync(serverEntryPath)) {
    phaseStart = performance.now();
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      resolve: appConfig.resolve,
      define: appConfig.define,
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
            ...(appConfig.ssrExternal ?? []),
          ],
          output: {
            format: "esm" as const,
            entryFileNames: "[name].js",
          },
        },
        minify: true,
      },
    });
    printPhase(4, "Server entry", performance.now() - phaseStart);
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
 * Load the app's vite.config.ts and extract plugins and resolve config,
 * filtering out plugins we add ourselves (React, react-flight-router).
 */
async function loadAppConfig(appRoot: string): Promise<{
  plugins: any[];
  resolve?: Record<string, any>;
  define?: Record<string, any>;
  ssrExternal?: string[];
}> {
  try {
    const result = await loadConfigFromFile(
      { command: "build", mode: "production" },
      undefined, // auto-detect config file
      appRoot,
    );
    if (!result?.config) return { plugins: [] };

    const skipNames = new Set([
      "vite:react-babel",
      "vite:react-jsx",
      "vite:react-refresh",
      "react-flight-router",
      "react-flight-router:rsc",
    ]);

    const plugins = (result.config.plugins ?? [])
      .flat()
      .filter(
        (p): p is any =>
          p != null && typeof p === "object" && "name" in p && !skipNames.has((p as any).name),
      );

    // Extract ssr.external from the app config so CJS-only packages
    // (e.g., isomorphic-dompurify/jsdom) aren't bundled into ESM chunks.
    const ssrExternal = Array.isArray(result.config.ssr?.external)
      ? (result.config.ssr.external as string[])
      : undefined;

    return { plugins, resolve: result.config.resolve, define: result.config.define, ssrExternal };
  } catch {
    return { plugins: [] };
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
 * gypfile flag, binary field, or platform-specific optional dependencies
 * in package.json.
 */
function detectNativeModules(appRoot: string): string[] {
  const pkgPath = resolve(appRoot, "package.json");
  if (!existsSync(pkgPath)) return [];

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const deps = Object.keys(pkg.dependencies ?? {});
  const native: string[] = [];

  // Platform keywords that indicate native/platform-specific optional deps
  const platformPatterns =
    /-(darwin|linux|win32|windows|freebsd|android|arm64|x64|x86|arm|s390x|ppc64|musl|gnu)/;

  for (const dep of deps) {
    try {
      const depPkgPath = resolve(appRoot, "node_modules", dep, "package.json");
      if (!existsSync(depPkgPath)) continue;
      const depPkg = JSON.parse(readFileSync(depPkgPath, "utf-8"));

      const installScript = depPkg.scripts?.install ?? "";

      // Check classic native module indicators
      if (
        depPkg.gypfile ||
        depPkg.binary ||
        installScript.includes("node-gyp") ||
        installScript.includes("prebuild-install") ||
        installScript.includes("node-pre-gyp")
      ) {
        native.push(dep);
        continue;
      }

      // Check for platform-specific optional dependencies (e.g., sharp uses
      // @img/sharp-darwin-arm64, @img/sharp-linux-x64, etc.)
      const optDeps = Object.keys(depPkg.optionalDependencies ?? {});
      if (optDeps.some((d: string) => platformPatterns.test(d))) {
        native.push(dep);
      }
    } catch {
      // Skip packages we can't read
    }
  }

  return native;
}
