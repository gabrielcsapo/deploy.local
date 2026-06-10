import { resolve } from "path";
import { createServer, loadConfigFromFile, type InlineConfig } from "vite";
import { flightRouter } from "./vite-plugin.js";

export interface DevServerOptions {
  /** Root directory of the app (where vite.config and app/ live). */
  appRoot: string;
  /** Port to listen on. Defaults to Vite's default (5173) when unset. */
  port?: number;
  /** Host to bind. `true` exposes on the network; a string binds a specific host. */
  host?: string | boolean;
  /** Open the browser on start. */
  open?: boolean;
}

/**
 * Start the react-flight-router dev server.
 *
 * Mirrors the `build` command's "batteries included" behaviour: it boots Vite
 * programmatically against the app's own `vite.config`, so user plugins
 * (Tailwind, custom API middleware, etc.) and `flightRouter` options
 * (`onRequest`, `onRequestComplete`, `routesFile`) are all preserved.
 *
 * When the app's config does NOT already register the flightRouter plugin,
 * we inject `@vitejs/plugin-react` + `flightRouter()` so a minimal app can run
 * `react-flight-router dev` with no Vite config at all.
 */
export async function startDevServer(opts: DevServerOptions): Promise<void> {
  const appRoot = resolve(opts.appRoot);

  const inlineConfig: InlineConfig = {
    root: appRoot,
    server: {
      port: opts.port,
      host: opts.host,
      open: opts.open,
    },
  };

  // If the app hasn't wired up flightRouter itself, provide it (plus React) so
  // a config-less app still gets RSC/SSR dev. When the app's config already
  // includes it, we leave plugins untouched to honour the user's options.
  if (!(await appHasFlightRouterPlugin(appRoot))) {
    const react = (await import("@vitejs/plugin-react")).default;
    inlineConfig.plugins = [react(), flightRouter()];
  }

  const server = await createServer(inlineConfig);
  await server.listen();
  server.printUrls();
  server.bindCLIShortcuts({ print: true });
}

/**
 * Inspect the app's vite config (if any) to detect whether the flightRouter
 * plugin is already registered. The plugin returns an array of plugins all
 * named `react-flight-router:*`, so we deep-flatten and look for that prefix.
 */
async function appHasFlightRouterPlugin(appRoot: string): Promise<boolean> {
  try {
    const result = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      undefined, // auto-detect config file
      appRoot,
    );
    if (!result?.config) return false;
    const plugins = ((result.config.plugins ?? []) as unknown[]).flat(Infinity) as unknown[];
    return plugins.some(
      (p) =>
        p != null &&
        typeof p === "object" &&
        "name" in p &&
        String((p as { name: unknown }).name).startsWith("react-flight-router"),
    );
  } catch {
    return false;
  }
}
