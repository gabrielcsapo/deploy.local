import { resolve } from 'path';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { build as viteBuild } from 'vite';
import react from '@vitejs/plugin-react';
import { createRSCServerConfig } from './vite-config-rsc.js';
import { createClientConfig } from './vite-config-client.js';
import { createSSRConfig } from './vite-config-ssr.js';
import { generateManifests } from './manifest-generator.js';

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

export async function build(opts: BuildOptions): Promise<void> {
  const appRoot = resolve(opts.appRoot);
  const outDir = resolve(opts.outDir ?? 'dist');
  const routesEntry = resolve(appRoot, opts.routesFile ?? 'app/routes.ts');
  const clientEntry = resolve(appRoot, opts.clientEntry ?? 'node_modules/flight-router/dist/client/entry.js');

  console.log('[flight-router] Starting build...');
  console.log(`  App root: ${appRoot}`);
  console.log(`  Output:   ${outDir}`);
  console.log(`  Routes:   ${routesEntry}`);

  // Pre-scan: discover 'use server' modules that may only be imported by client
  // components (which get replaced in RSC mode, hiding their imports).
  const serverActionEntries = scanForServerModules(appRoot);
  if (serverActionEntries.length > 0) {
    console.log(`  Found ${serverActionEntries.length} 'use server' module(s) via pre-scan`);
  }

  // Phase 1: RSC Server Build
  console.log('\n[flight-router] Phase 1: Building RSC server bundle...');
  const rscConfig = createRSCServerConfig({
    appDir: appRoot,
    outDir,
    routesEntry,
    serverActionEntries,
  });

  await viteBuild(rscConfig.config);

  const clientModules = rscConfig.getClientModules();
  const serverModules = rscConfig.getServerModules();
  console.log(`  Found ${clientModules.size} client modules`);
  console.log(`  Found ${serverModules.size} server action modules`);

  // Phase 2: Client Build
  console.log('\n[flight-router] Phase 2: Building client bundle...');
  const clientConfig = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules,
    clientEntryPath: clientEntry,
  });

  // Add React plugin for JSX
  clientConfig.plugins = [react(), ...(clientConfig.plugins ?? [])];

  await viteBuild(clientConfig);

  // Phase 3: SSR Build
  console.log('\n[flight-router] Phase 3: Building SSR bundle...');
  const ssrConfig = createSSRConfig({
    appDir: appRoot,
    outDir,
    clientModules,
  });

  ssrConfig.plugins = [react(), ...(ssrConfig.plugins ?? [])];

  await viteBuild(ssrConfig);

  // Phase 4: Generate manifests
  console.log('\n[flight-router] Phase 4: Generating manifests...');
  generateManifests({
    outDir,
    clientModules,
    serverModules,
  });

  // Phase 5: Build server entry
  const serverEntryPath = resolve(appRoot, opts.serverEntry ?? 'server.ts');
  if (existsSync(serverEntryPath)) {
    console.log('\n[flight-router] Phase 5: Building server entry...');
    await viteBuild({
      configFile: false,
      build: {
        ssr: true,
        outDir,
        emptyOutDir: false,
        rollupOptions: {
          input: { server: serverEntryPath },
          external: [
            'react',
            'react/jsx-runtime',
            'react/jsx-dev-runtime',
            'react-dom',
            'react-dom/server',
            'react-dom/client',
            'react-server-dom-webpack/client.node',
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
          },
        },
        minify: false,
      },
    });
  }

  console.log('\n[flight-router] Build complete!');
  console.log(`  Output: ${outDir}/`);
  console.log('  - server.js (production server entry)');
  console.log('  - server/rsc-entry.js (RSC server bundle)');
  console.log('  - server/ssr/ (SSR client components)');
  console.log('  - client/assets/ (client JS + CSS)');
  console.log('  - rsc-client-manifest.json');
  console.log('  - ssr-manifest.json');
  console.log('  - server-actions-manifest.json');
}

/**
 * Scan the app directory for files containing 'use server' directive.
 * This catches server action modules that are only imported by client components
 * (which get replaced in the RSC build, hiding their server action imports).
 */
function scanForServerModules(appRoot: string): string[] {
  const appDir = resolve(appRoot, 'app');
  if (!existsSync(appDir)) return [];

  const serverModules: string[] = [];
  const entries = readdirSync(appDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    const fullPath = resolve(entry.parentPath, entry.name);
    const content = readFileSync(fullPath, 'utf-8');

    if (/^['"]use server['"];?/m.test(content.trimStart())) {
      serverModules.push(fullPath);
    }
  }

  return serverModules;
}
