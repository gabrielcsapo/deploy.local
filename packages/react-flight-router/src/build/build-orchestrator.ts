import { resolve, dirname } from "path";
import { existsSync, readdirSync, readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  createBuilder,
  loadConfigFromFile,
  type EnvironmentOptions,
  type InlineConfig,
  type Plugin,
  type PluginOption,
} from "vite";
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
  /**
   * Directory to copy verbatim to the client build root (favicons, robots,
   * manifests, etc.). Resolved relative to `appRoot`. Default: `"public"`
   * (i.e. `<appRoot>/public`). Pass `false` to disable.
   */
  publicDir?: string | false;
}

/** Packages the server entry bundle must not bundle (shared singletons / node-native). */
const SERVER_ENTRY_EXTERNALS = [
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
];

/** Flatten a Vite `plugins` value (nested arrays / falsy entries) to plugin objects. */
function flattenPlugins(plugins: InlineConfig["plugins"]): Plugin[] {
  if (!plugins) return [];
  return (plugins as PluginOption[])
    .flat(Infinity as 1)
    .filter((p): p is Plugin => !!p && typeof p === "object" && "name" in p);
}

/** Restrict a set of plugins to the named build environments. */
function scopePlugins(plugins: Plugin[], envNames: string[]): Plugin[] {
  for (const p of plugins) {
    p.applyToEnvironment = (env) => envNames.includes(env.name);
  }
  return plugins;
}

/**
 * Fold a standalone InlineConfig into per-environment options. Plugins are
 * handled separately (scoped at the top level), so they're dropped here.
 * `ssr.noExternal`/`ssr.external` map onto the environment's resolve options.
 */
function toEnvOptions(cfg: InlineConfig): EnvironmentOptions {
  const env: EnvironmentOptions = {};
  if (cfg.define) env.define = cfg.define;

  const resolve: Record<string, unknown> = { ...cfg.resolve };
  if (cfg.ssr?.noExternal !== undefined) resolve.noExternal = cfg.ssr.noExternal;
  if (cfg.ssr?.external !== undefined) resolve.external = cfg.ssr.external;
  if (Object.keys(resolve).length > 0) env.resolve = resolve as EnvironmentOptions["resolve"];

  if (cfg.build) env.build = cfg.build as EnvironmentOptions["build"];
  env.consumer = cfg.build?.ssr ? "server" : "client";
  return env;
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

  // ---------------------------------------------------------------------
  // Single multi-environment build.
  //
  // One Vite config resolution drives four build environments instead of
  // spinning up four separate Vite instances:
  //   rsc     → server components; discovers which modules are 'use client'
  //   client  → browser bundles (inputs depend on rsc's discovery)
  //   ssr     → server render of client components (inputs depend on rsc)
  //   server  → the app's server.ts entry (fully independent of the others)
  //
  // Plugins are registered once at the top level and scoped to environments
  // via `applyToEnvironment`, mirroring the previous per-config plugin sets:
  //   - framework rsc plugins → rsc only
  //   - @vitejs/plugin-react  → client + ssr (rsc uses esbuild + react-server)
  //   - app plugins (Tailwind, aliases) → rsc + client (as before)
  // ---------------------------------------------------------------------
  printBuildStart();

  // Resolve publicDir to an absolute path under appRoot when given as a
  // string. `false` disables the copy. When the resolved path doesn't exist
  // we silently pass `false` so Vite doesn't warn about a missing directory.
  let resolvedPublicDir: string | false;
  if (opts.publicDir === false) {
    resolvedPublicDir = false;
  } else {
    const candidate = resolve(appRoot, opts.publicDir ?? "public");
    resolvedPublicDir = existsSync(candidate) ? candidate : false;
  }

  const serverEntryPath = resolve(appRoot, opts.serverEntry ?? "server.ts");
  const hasServerEntry = existsSync(serverEntryPath);

  // Build the per-environment InlineConfigs from the existing factories so all
  // the subtle settings (react-server conditions, externalization, dedup) stay
  // in one place, then fold each into an EnvironmentOptions + scoped plugins.
  const rscFactory = createRSCServerConfig({
    appDir: appRoot,
    outDir,
    routesEntry,
    serverActionEntries,
    external: [...nativeModules, ...(appConfig.ssrExternal ?? [])],
  });
  const rscInline = rscFactory.config;
  // Forward user-defined globals (e.g., __APP_VERSION__), merging with the RSC
  // build's own defines (process.env.NODE_ENV) so neither set is lost.
  if (appConfig.define) rscInline.define = { ...appConfig.define, ...rscInline.define };
  // Forward resolve config (e.g., path aliases like @/) from the user's vite.config.
  if (appConfig.resolve) rscInline.resolve = { ...rscInline.resolve, ...appConfig.resolve };

  // client/ssr inputs depend on rsc discovery — start with empty module sets
  // and mutate the resolved environment inputs after the rsc build completes.
  const clientInline = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules: new Set(),
    clientEntryPath: clientEntry,
    cssEntries,
    publicDir: resolvedPublicDir,
  });
  if (appConfig.resolve) clientInline.resolve = { ...clientInline.resolve, ...appConfig.resolve };
  if (appConfig.define) clientInline.define = { ...appConfig.define, ...clientInline.define };

  const ssrInline = createSSRConfig({ appDir: appRoot, outDir, clientModules: new Set() });
  if (appConfig.resolve) ssrInline.resolve = { ...ssrInline.resolve, ...appConfig.resolve };
  if (appConfig.define) ssrInline.define = { ...appConfig.define, ...ssrInline.define };

  const serverInline: InlineConfig | null = hasServerEntry
    ? {
        resolve: appConfig.resolve,
        define: appConfig.define,
        build: {
          ssr: true,
          outDir,
          emptyOutDir: false,
          rollupOptions: {
            input: { server: serverEntryPath },
            external: [
              ...SERVER_ENTRY_EXTERNALS,
              ...nativeModules,
              ...(appConfig.ssrExternal ?? []),
            ],
            output: { format: "esm" as const, entryFileNames: "[name].js" },
          },
          minify: true,
        },
      }
    : null;

  // Scope plugins to the environments that previously received them.
  const allPlugins: Plugin[] = [
    ...scopePlugins(flattenPlugins(rscInline.plugins), ["rsc"]),
    ...scopePlugins(flattenPlugins(clientInline.plugins), ["client"]),
    ...scopePlugins(flattenPlugins(ssrInline.plugins), ["ssr"]),
    ...scopePlugins(flattenPlugins(react()), ["client", "ssr"]),
    ...scopePlugins(flattenPlugins(appPlugins), ["rsc", "client"]),
  ];

  const builder = await createBuilder({
    configFile: false,
    root: appRoot,
    logLevel: "silent",
    plugins: allPlugins,
    environments: {
      rsc: toEnvOptions(rscInline),
      client: toEnvOptions(clientInline),
      ssr: toEnvOptions(ssrInline),
      ...(serverInline ? { server: toEnvOptions(serverInline) } : {}),
    },
  });

  // The server entry depends on nothing else — kick it off immediately so it
  // overlaps the rsc/client/ssr builds.
  let serverDuration = 0;
  const serverPromise = serverInline
    ? (async () => {
        const start = performance.now();
        await builder.build(builder.environments.server);
        serverDuration = performance.now() - start;
      })()
    : null;

  // Phase 1: RSC build — discovers client/server modules.
  let phaseStart = performance.now();
  const rscOutput = (await builder.build(builder.environments.rsc)) as RollupOutput;
  const clientModules = rscFactory.getClientModules();
  const serverModules = rscFactory.getServerModules();
  printPhase(1, "RSC server", performance.now() - phaseStart);

  // Now that client modules are known, set the client/ssr entry inputs on the
  // already-resolved environments (verified to be honoured at build time).
  const realClient = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules,
    clientEntryPath: clientEntry,
    cssEntries,
    publicDir: resolvedPublicDir,
  });
  const realSSR = createSSRConfig({ appDir: appRoot, outDir, clientModules });
  builder.environments.client.config.build.rollupOptions.input =
    realClient.build!.rollupOptions!.input;
  builder.environments.ssr.config.build.rollupOptions.input = realSSR.build!.rollupOptions!.input;

  // Phase 2: client + ssr build concurrently (both depend only on rsc output).
  const parallelStart = performance.now();
  await Promise.all([
    builder.build(builder.environments.client),
    builder.build(builder.environments.ssr),
  ]);
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

  // Phase 4: await the server entry build started above.
  if (serverPromise) {
    await serverPromise;
    printPhase(4, "Server entry", serverDuration);
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
export function detectNativeModules(appRoot: string): string[] {
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
      const depDir = dirname(depPkgPath);

      const installScript = depPkg.scripts?.install ?? "";

      // Check classic native module indicators
      if (
        existsSync(resolve(depDir, "binding.gyp")) ||
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
