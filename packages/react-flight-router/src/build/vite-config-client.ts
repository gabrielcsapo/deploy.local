import { resolve } from 'path';
import type { InlineConfig } from 'vite';
import { useServerPlugin } from './plugin-use-server.js';
import { getModuleId } from './plugin-use-client.js';

interface ClientBuildOptions {
  appDir: string;
  outDir: string;
  clientModules: Set<string>;
  clientEntryPath: string;
}

export function createClientConfig(opts: ClientBuildOptions): InlineConfig {
  // Each client component file becomes an entry for code splitting
  const clientEntries: Record<string, string> = {
    'entry-client': opts.clientEntryPath,
  };

  for (const mod of opts.clientModules) {
    const id = getModuleId(mod);
    clientEntries[id] = mod;
  }

  return {
    configFile: false,
    build: {
      outDir: resolve(opts.outDir, 'client'),
      emptyOutDir: true,
      manifest: true,
      rollupOptions: {
        input: clientEntries,
        // Client component modules are loaded at runtime via __webpack_require__,
        // so Rollup can't see their usage and would tree-shake their exports.
        preserveEntrySignatures: 'exports-only',
        output: {
          format: 'esm' as const,
          entryFileNames: 'assets/[name]-[hash].js',
          chunkFileNames: 'assets/[name]-[hash].js',
          assetFileNames: 'assets/[name]-[hash].[ext]',
        },
      },
      minify: true,
    },
    plugins: [
      useServerPlugin({ mode: 'client' }),
    ],
  };
}
