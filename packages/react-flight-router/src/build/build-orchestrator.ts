import { resolve, relative } from 'path';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { build as viteBuild, loadConfigFromFile } from 'vite';
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

  const buildStart = performance.now();

  console.log('[flight-router] Starting build...');
  console.log(`  App root: ${appRoot}`);
  console.log(`  Output:   ${outDir}`);
  console.log(`  Routes:   ${routesEntry}`);

  // Load the app's vite.config to pick up user-configured plugins (e.g., Tailwind).
  // We filter out plugins we add ourselves (React, flight-router).
  const appPlugins = await loadAppPlugins(appRoot);
  if (appPlugins.length > 0) {
    console.log(`  Loaded ${appPlugins.length} plugin(s) from app vite config`);
  }

  // Scan for CSS files imported in the app (e.g., `import './styles.css'`).
  // These need to be included in the client build since server components
  // don't produce client-side CSS.
  const cssEntries = scanForCSSImports(appRoot);
  if (cssEntries.length > 0) {
    console.log(`  Found ${cssEntries.length} CSS entry file(s)`);
  }

  // Pre-scan: discover 'use server' modules that may only be imported by client
  // components (which get replaced in RSC mode, hiding their imports).
  const serverActionEntries = scanForServerModules(appRoot);
  if (serverActionEntries.length > 0) {
    console.log(`  Found ${serverActionEntries.length} 'use server' module(s) via pre-scan`);
  }

  // Phase 1: RSC Server Build
  let phaseStart = performance.now();
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
  console.log(`  ${clientModules.size} client module(s), ${serverModules.size} server action module(s)`);
  console.log(`  \u2713 done in ${formatDuration(performance.now() - phaseStart)}`);

  // Phase 2: Client Build
  phaseStart = performance.now();
  console.log('\n[flight-router] Phase 2: Building client bundle...');
  const clientConfig = createClientConfig({
    appDir: appRoot,
    outDir,
    clientModules,
    clientEntryPath: clientEntry,
    cssEntries,
  });

  // Add React plugin + app plugins (e.g., Tailwind) for the client build
  clientConfig.plugins = [react(), ...appPlugins, ...(clientConfig.plugins ?? [])];

  await viteBuild(clientConfig);
  console.log(`  \u2713 done in ${formatDuration(performance.now() - phaseStart)}`);

  // Phase 3: SSR Build
  phaseStart = performance.now();
  console.log('\n[flight-router] Phase 3: Building SSR bundle...');
  const ssrConfig = createSSRConfig({
    appDir: appRoot,
    outDir,
    clientModules,
  });

  ssrConfig.plugins = [react(), ...(ssrConfig.plugins ?? [])];

  await viteBuild(ssrConfig);
  console.log(`  \u2713 done in ${formatDuration(performance.now() - phaseStart)}`);

  // Phase 4: Generate manifests
  phaseStart = performance.now();
  console.log('\n[flight-router] Phase 4: Generating manifests...');
  generateManifests({
    outDir,
    clientModules,
    serverModules,
  });
  console.log(`  \u2713 done in ${formatDuration(performance.now() - phaseStart)}`);

  // Phase 5: Build server entry
  const serverEntryPath = resolve(appRoot, opts.serverEntry ?? 'server.ts');
  if (existsSync(serverEntryPath)) {
    phaseStart = performance.now();
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
    console.log(`  \u2713 done in ${formatDuration(performance.now() - phaseStart)}`);
  }

  const totalDuration = performance.now() - buildStart;

  // Collect output files and print summary
  const files = collectOutputFiles(outDir, outDir);

  const categories: { label: string; filter: (f: OutputFile) => boolean }[] = [
    { label: 'server', filter: (f) => f.path === 'server.js' || (f.path.startsWith('server/') && !f.path.startsWith('server/ssr/')) },
    { label: 'ssr', filter: (f) => f.path.startsWith('server/ssr/') },
    { label: 'client', filter: (f) => f.path.startsWith('client/') && !f.path.endsWith('.json') },
    { label: 'manifests', filter: (f) => f.path.endsWith('.json') },
  ];

  console.log(`\n[flight-router] \u2713 build complete in ${formatDuration(totalDuration)}\n`);

  for (const { label, filter } of categories) {
    const catFiles = files.filter(filter);
    if (catFiles.length === 0) continue;
    const totalSize = catFiles.reduce((sum, f) => sum + f.size, 0);
    const jsFiles = catFiles.filter((f) => f.path.endsWith('.js'));
    const cssFiles = catFiles.filter((f) => f.path.endsWith('.css'));
    const jsonFiles = catFiles.filter((f) => f.path.endsWith('.json'));

    const parts: string[] = [];
    if (jsFiles.length > 0) parts.push(`${jsFiles.length} js`);
    if (cssFiles.length > 0) parts.push(`${cssFiles.length} css`);
    if (jsonFiles.length > 0) parts.push(`${jsonFiles.length} json`);

    console.log(`  ${label.padEnd(12)} ${parts.join(', ').padEnd(20)} ${formatSize(totalSize).padStart(10)}`);
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`  ${''.padEnd(12)} ${''.padEnd(20)} ${'──────────'}`);
  console.log(`  ${'total'.padEnd(12)} ${`${files.length} files`.padEnd(20)} ${formatSize(totalSize).padStart(10)}`);
  console.log('');
}

/**
 * Load the app's vite.config.ts and extract plugins, filtering out
 * plugins we add ourselves (React, flight-router).
 */
async function loadAppPlugins(appRoot: string): Promise<any[]> {
  try {
    const result = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      undefined, // auto-detect config file
      appRoot,
    );
    if (!result?.config.plugins) return [];

    const skipNames = new Set([
      'vite:react-babel',
      'vite:react-jsx',
      'vite:react-refresh',
      'flight-router',
      'flight-router:rsc',
    ]);

    return result.config.plugins
      .flat()
      .filter((p): p is any =>
        p != null &&
        typeof p === 'object' &&
        'name' in p &&
        !skipNames.has((p as any).name),
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
  const appDir = resolve(appRoot, 'app');
  if (!existsSync(appDir)) return [];

  const cssFiles: string[] = [];
  const entries = readdirSync(appDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;

    const fullPath = resolve(entry.parentPath, entry.name);
    const content = readFileSync(fullPath, 'utf-8');

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

interface OutputFile {
  path: string;
  size: number;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} kB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

function collectOutputFiles(dir: string, rootDir: string): OutputFile[] {
  const files: OutputFile[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = resolve(entry.parentPath, entry.name);
    const relPath = relative(rootDir, fullPath);
    files.push({ path: relPath, size: statSync(fullPath).size });
  }

  return files.sort((a, b) => a.size - b.size);
}

