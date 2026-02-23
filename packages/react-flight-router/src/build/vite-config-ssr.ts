import { resolve } from 'path';
import type { InlineConfig } from 'vite';
import { useServerPlugin } from './plugin-use-server.js';
import { getModuleId } from './plugin-use-client.js';

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
      outDir: resolve(opts.outDir, 'server/ssr'),
      emptyOutDir: true,
      rollupOptions: {
        input: ssrEntries,
        external: [
          'react',
          'react/jsx-runtime',
          'react/jsx-dev-runtime',
          'react-dom',
          'react-dom/server',
          'react-server-dom-webpack/client.node',
          'react-server-dom-webpack/client',
          'hono',
          '@hono/node-server',
          'flight-router',
          'flight-router/server',
          'flight-router/client',
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
      useServerPlugin({ mode: 'ssr' }),
    ],
  };
}
