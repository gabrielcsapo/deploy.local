import { resolve, dirname } from 'path';
import type { InlineConfig, Plugin } from 'vite';
import { useClientPlugin, getModuleId } from './plugin-use-client.js';
import { useServerPlugin } from './plugin-use-server.js';
import { collectClientModulesPlugin } from './plugin-collect-client-modules.js';

const RSC_RUNTIME_ID = 'virtual:rsc-runtime';

/**
 * Maps React package imports to their react-server variant files.
 * Vite's resolve.conditions doesn't reliably apply to CJS require()
 * calls inside bundled packages, so we redirect explicitly.
 */
const REACT_SERVER_FILE_MAP: Record<string, string> = {
  'react': 'react.react-server.js',
  'react/jsx-runtime': 'jsx-runtime.react-server.js',
  'react/jsx-dev-runtime': 'jsx-dev-runtime.react-server.js',
};

/**
 * Plugin that bundles a virtual RSC runtime entry and resolves React
 * to its react-server variant. This allows the production server to
 * use renderToReadableStream without --conditions=react-server.
 */
function rscRuntimePlugin(): Plugin {
  return {
    name: 'flight-router:rsc-runtime',
    enforce: 'pre',
    async resolveId(id, importer, options) {
      if (id === RSC_RUNTIME_ID) return id;

      // Redirect react imports to react-server variant files
      const serverFile = REACT_SERVER_FILE_MAP[id];
      if (serverFile) {
        // Resolve normally to find the package location, then swap the file
        const resolved = await this.resolve(id, importer, {
          ...options,
          skipSelf: true,
        });
        if (resolved && !resolved.external) {
          const dir = dirname(resolved.id);
          return { id: resolve(dir, serverFile) };
        }
      }
    },
    load(id) {
      if (id === RSC_RUNTIME_ID) {
        return `export { renderToReadableStream, decodeReply, registerClientReference, registerServerReference } from 'react-server-dom-webpack/server.node';`;
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
      'process.env.NODE_ENV': '"production"',
    },
    resolve: {
      conditions: ['react-server', 'node', 'import'],
    },
    ssr: {
      // Force these packages to be bundled (not externalized) so that
      // resolve.conditions: ['react-server'] applies at build time.
      // Without this, Vite's SSR mode auto-externalizes bare imports
      // and they'd be loaded from node_modules at runtime without
      // the react-server condition.
      noExternal: [
        'react',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'react-server-dom-webpack',
        // flight-router/client must be bundled so useClientPlugin can
        // detect 'use client' and replace with registerClientReference
        'flight-router',
      ],
    },
    build: {
      ssr: true,
      outDir: resolve(opts.outDir, 'server'),
      emptyOutDir: false,
      rollupOptions: {
        input: {
          'rsc-entry': opts.routesEntry,
          'rsc-runtime': RSC_RUNTIME_ID,
          // Include pre-scanned 'use server' modules as entries so they're
          // processed even if only imported by client components (which get
          // replaced with registerClientReference proxies in RSC mode).
          ...Object.fromEntries(
            (opts.serverActionEntries ?? []).map(f => [
              `server-action-${getModuleId(f).replace(/\//g, '-')}`,
              f,
            ]),
          ),
        },
        external: [
          // React and react-server-dom-webpack/server are NOT external here -
          // they get bundled with the react-server condition so the production
          // server can use renderToReadableStream without needing
          // --conditions=react-server at runtime.
          // flight-router/client is also NOT external - it needs to be
          // processed by useClientPlugin to replace 'use client' files
          // with registerClientReference proxies.
          'react-dom',
          'react-dom/server',
          'hono',
          '@hono/node-server',
          'flight-router/server',
          'flight-router/router',
        ],
        output: {
          format: 'esm' as const,
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
      minify: false,
    },
    plugins: [
      rscRuntimePlugin(),
      useClientPlugin({
        mode: 'rsc-server',
        onClientModule: (id) => clientCollector.collectedModules.add(id),
      }),
      useServerPlugin({
        mode: 'rsc-server',
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
