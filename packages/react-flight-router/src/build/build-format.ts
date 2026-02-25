import { resolve, relative, dirname, extname } from "path";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { gzipSync } from "zlib";
import { transformWithEsbuild } from "vite";

// Minimal Rollup types we need (avoids requiring rollup as a direct dependency)
interface RollupOutputChunk {
  type: "chunk";
  code: string;
  facadeModuleId: string | null;
  fileName: string;
}

interface RollupOutputAsset {
  type: "asset";
  fileName: string;
}

export interface RollupOutput {
  output: (RollupOutputChunk | RollupOutputAsset)[];
}

// ---------------------------------------------------------------------------
// ANSI colors (gated on TTY + NO_COLOR)
// ---------------------------------------------------------------------------

const supportsColor =
  typeof process !== "undefined" && process.stdout?.isTTY === true && !process.env.NO_COLOR;

const c = {
  bold: (s: string) => (supportsColor ? `\x1b[1m${s}\x1b[22m` : s),
  dim: (s: string) => (supportsColor ? `\x1b[2m${s}\x1b[22m` : s),
  green: (s: string) => (supportsColor ? `\x1b[32m${s}\x1b[39m` : s),
  cyan: (s: string) => (supportsColor ? `\x1b[36m${s}\x1b[39m` : s),
  yellow: (s: string) => (supportsColor ? `\x1b[33m${s}\x1b[39m` : s),
  gray: (s: string) => (supportsColor ? `\x1b[90m${s}\x1b[39m` : s),
};

// ---------------------------------------------------------------------------
// Shared formatting helpers (moved from build-orchestrator.ts)
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} kB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export interface OutputFile {
  path: string;
  size: number;
}

export function collectOutputFiles(dir: string, rootDir: string): OutputFile[] {
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

// ---------------------------------------------------------------------------
// Route parsing
// ---------------------------------------------------------------------------

export interface ParsedRoute {
  id: string;
  path?: string;
  index?: boolean;
  componentPath?: string;
  children?: ParsedRoute[];
}

/**
 * Parse the routes.ts file to extract the route tree structure.
 * Strips TypeScript types and dynamic imports, then evaluates the structure.
 * Returns empty array on any failure — build should never fail due to formatting.
 */
export async function parseRoutes(routesFilePath: string): Promise<ParsedRoute[]> {
  try {
    const raw = readFileSync(routesFilePath, "utf-8");

    // Strip import type lines
    let cleaned = raw.replace(/import\s+type\s+[^;]*;\s*/g, "");

    // Replace component: () => import("./path") with componentPath: "./path"
    cleaned = cleaned.replace(
      /component\s*:\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)\s*/g,
      'componentPath: "$1" ',
    );

    // Use esbuild (via Vite) to strip remaining TS syntax
    const result = await transformWithEsbuild(cleaned, routesFilePath, {
      loader: "ts",
    });

    // Strip exports and convert to a function body that returns the routes array
    let code = result.code;
    // Handle `export const routes = [...]`
    code = code.replace(/export\s+const\s+routes\s*=\s*/, "return ");
    // Handle esbuild ESM split: `const routes = [...]; export { routes };`
    code = code.replace(/const\s+routes\s*=\s*/, "return ");
    code = code.replace(/export\s*\{[^}]*\}\s*;?/g, "");

    const fn = new Function(code);
    return fn();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Route flattening for display
// ---------------------------------------------------------------------------

export interface FlatRoute {
  id: string;
  fullPath: string;
  isDynamic: boolean;
  depth: number;
  treePrefix: string;
  children?: FlatRoute[];
}

/**
 * Flatten a route tree into a displayable list with tree-drawing characters.
 * If the tree has a single root layout, we "unwrap" it and show its children
 * as top-level entries for a cleaner display.
 */
export function flattenRoutes(routes: ParsedRoute[]): FlatRoute[] {
  // If there's a single root layout with children, unwrap it for cleaner display
  if (routes.length === 1 && routes[0].children && routes[0].children.length > 0) {
    const root = routes[0];
    const rootPath = root.path ? "/" + root.path : "/";
    const result: FlatRoute[] = [];

    // Add the root layout as a standalone entry
    result.push({
      id: root.id,
      fullPath: rootPath,
      isDynamic: rootPath.includes(":"),
      depth: 0,
      treePrefix: "",
    });

    // Flatten its children as the top-level tree
    result.push(...flattenRoutesInner(root.children!, rootPath === "/" ? "" : rootPath, 0, ""));

    return result;
  }

  return flattenRoutesInner(routes, "", 0, "");
}

function flattenRoutesInner(
  routes: ParsedRoute[],
  parentPath: string,
  depth: number,
  parentPrefix: string,
): FlatRoute[] {
  const result: FlatRoute[] = [];

  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    const isLast = i === routes.length - 1;
    const segment = route.path ?? "";

    let fullPath: string;
    if (route.index) {
      // Index routes match the parent path — show with trailing / to distinguish
      fullPath = parentPath ? parentPath + "/" : "/";
    } else {
      fullPath = parentPath ? (parentPath + "/" + segment).replace(/\/+/g, "/") : "/" + segment;
    }

    if (!fullPath.startsWith("/")) fullPath = "/" + fullPath;

    const isDynamic = fullPath.includes(":");
    const treeChar = isLast ? "└" : i === 0 && depth === 0 ? "┌" : "├";
    const connector = parentPrefix + treeChar + " ";

    result.push({
      id: route.id,
      fullPath,
      isDynamic,
      depth,
      treePrefix: connector,
    });

    if (route.children && route.children.length > 0) {
      const childPrefix = parentPrefix + (isLast ? "  " : "│ ");
      result.push(
        ...flattenRoutesInner(route.children, fullPath.replace(/\/$/, ""), depth + 1, childPrefix),
      );
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Route → client module mapping
// ---------------------------------------------------------------------------

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

/**
 * Resolve a module path to an actual file, trying common extensions.
 */
function resolveModulePath(importPath: string, fromDir: string): string | null {
  // If it already has a known extension, try it first then try swapping
  const ext = extname(importPath);
  const base = ext ? importPath.slice(0, -ext.length) : importPath;
  const resolved = resolve(fromDir, base);

  for (const tryExt of EXTENSIONS) {
    const candidate = resolved + tryExt;
    if (existsSync(candidate)) return candidate;
  }

  // Try the original path as-is
  const asIs = resolve(fromDir, importPath);
  if (existsSync(asIs)) return asIs;

  return null;
}

/**
 * Scan a source file for import paths, returning all relative imports.
 */
function extractImports(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const imports: string[] = [];
    // Match: import ... from "..." / import "..."
    const regex = /import\s+(?:.*?\s+from\s+)?['"]([^'"]+)['"]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      const specifier = match[1];
      // Only follow relative imports
      if (specifier.startsWith(".")) {
        imports.push(specifier);
      }
    }
    return imports;
  } catch {
    return [];
  }
}

/**
 * For each route, find which client modules it depends on by scanning
 * import chains from the route component file.
 */
export function resolveRouteClientModules(
  routes: ParsedRoute[],
  routesDir: string,
  clientModules: Set<string>,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  function findClientDeps(filePath: string, visited: Set<string>): Set<string> {
    const deps = new Set<string>();
    if (visited.has(filePath)) return deps;
    visited.add(filePath);

    const imports = extractImports(filePath);
    const fileDir = dirname(filePath);

    for (const imp of imports) {
      const resolved = resolveModulePath(imp, fileDir);
      if (!resolved) continue;

      if (clientModules.has(resolved)) {
        // This is a 'use client' module — add it as a dependency
        deps.add(resolved);
      } else {
        // Recurse into server component files
        for (const dep of findClientDeps(resolved, visited)) {
          deps.add(dep);
        }
      }
    }

    return deps;
  }

  function walkRoutes(routes: ParsedRoute[]) {
    for (const route of routes) {
      if (route.componentPath) {
        const componentFile = resolveModulePath(route.componentPath, routesDir);
        if (componentFile) {
          const deps = findClientDeps(componentFile, new Set());
          result.set(route.id, deps);
        } else {
          result.set(route.id, new Set());
        }
      } else {
        result.set(route.id, new Set());
      }

      if (route.children) {
        walkRoutes(route.children);
      }
    }
  }

  walkRoutes(routes);
  return result;
}

// ---------------------------------------------------------------------------
// Size computation
// ---------------------------------------------------------------------------

interface ViteManifestEntry {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
  dynamicImports?: string[];
}

type ViteManifest = Record<string, ViteManifestEntry>;

export interface SharedChunkInfo {
  path: string;
  size: number;
}

export interface RouteSizeInfo {
  serverSize: number;
  routeSpecificClientSize: number;
  firstLoadJS: number;
}

export interface BuildSizeData {
  sharedSize: number;
  sharedGzipSize: number;
  sharedChunks: SharedChunkInfo[];
  routes: Map<string, RouteSizeInfo>;
}

/**
 * Compute per-route sizes using the Vite manifest and Phase 1 RollupOutput.
 */
export function computeRouteSizes(
  outDir: string,
  routeClientModules: Map<string, Set<string>>,
  rscOutput: RollupOutput | RollupOutput[],
  clientModules: Set<string>,
): BuildSizeData {
  const clientDir = resolve(outDir, "client");
  const manifestPath = resolve(clientDir, ".vite/manifest.json");

  let viteManifest: ViteManifest = {};
  try {
    viteManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    // If no manifest, return empty data
    return {
      sharedSize: 0,
      sharedGzipSize: 0,
      sharedChunks: [],
      routes: new Map(),
    };
  }

  // 1. Compute shared chunks (entry-client + its static imports, recursively)
  const sharedChunkKeys = new Set<string>();

  function collectImports(key: string) {
    if (sharedChunkKeys.has(key)) return;
    sharedChunkKeys.add(key);
    const entry = viteManifest[key];
    if (entry?.imports) {
      for (const imp of entry.imports) {
        collectImports(imp);
      }
    }
  }

  // Find entry-client in manifest
  const entryClientKey = Object.keys(viteManifest).find((k) => {
    const e = viteManifest[k];
    return (
      e.isEntry &&
      (k.includes("entry-client") || k.includes("entry.js") || e.name === "entry-client")
    );
  });

  if (entryClientKey) {
    collectImports(entryClientKey);
  }

  // Also include dynamic imports of the entry as shared (React runtime chunks)
  if (entryClientKey) {
    const entry = viteManifest[entryClientKey];
    if (entry.dynamicImports) {
      for (const dyn of entry.dynamicImports) {
        collectImports(dyn);
      }
    }
  }

  // Collect shared chunk file paths and sizes
  const sharedFilePaths = new Set<string>();
  const sharedChunks: SharedChunkInfo[] = [];
  let sharedTotalBytes = 0;

  for (const key of sharedChunkKeys) {
    const entry = viteManifest[key];
    if (!entry) continue;
    const filePath = resolve(clientDir, entry.file);
    if (!existsSync(filePath)) continue;

    const size = statSync(filePath).size;
    sharedFilePaths.add(entry.file);
    sharedChunks.push({ path: entry.file, size });
    sharedTotalBytes += size;
  }

  // Sort shared chunks descending by size
  sharedChunks.sort((a, b) => b.size - a.size);

  // Compute gzip of all shared chunks combined
  let sharedGzipSize = 0;
  for (const chunk of sharedChunks) {
    const filePath = resolve(clientDir, chunk.path);
    try {
      const content = readFileSync(filePath);
      sharedGzipSize += gzipSync(content, { level: 1 }).length;
    } catch {
      // skip
    }
  }

  // 2. Build map: clientModulePath → Vite manifest key
  const clientModuleToManifestKey = new Map<string, string>();
  for (const mod of clientModules) {
    for (const [key, entry] of Object.entries(viteManifest)) {
      if (!entry.isEntry) continue;
      // Match: exact key, module path ends with entry.src, or module path ends with key
      if (key === mod || (entry.src && mod.endsWith(entry.src)) || mod.endsWith(key)) {
        clientModuleToManifestKey.set(mod, key);
        break;
      }
    }
  }

  // 3. Compute route-specific client sizes
  function getRouteSpecificSize(clientMods: Set<string>): number {
    let total = 0;
    const counted = new Set<string>();

    for (const mod of clientMods) {
      const manifestKey = clientModuleToManifestKey.get(mod);
      if (!manifestKey) continue;

      const entry = viteManifest[manifestKey];
      if (!entry) continue;

      // Count the module's own file if not shared
      if (!sharedFilePaths.has(entry.file) && !counted.has(entry.file)) {
        counted.add(entry.file);
        const filePath = resolve(clientDir, entry.file);
        if (existsSync(filePath)) {
          total += statSync(filePath).size;
        }
      }

      // Count non-shared imports
      if (entry.imports) {
        for (const imp of entry.imports) {
          const impEntry = viteManifest[imp];
          if (impEntry && !sharedFilePaths.has(impEntry.file) && !counted.has(impEntry.file)) {
            counted.add(impEntry.file);
            const filePath = resolve(clientDir, impEntry.file);
            if (existsSync(filePath)) {
              total += statSync(filePath).size;
            }
          }
        }
      }
    }

    return total;
  }

  // 4. Server sizes from Phase 1 RollupOutput
  const serverChunkSizes = new Map<string, number>();
  const outputs = Array.isArray(rscOutput) ? rscOutput : [rscOutput];

  for (const output of outputs) {
    for (const chunk of output.output) {
      if (chunk.type === "chunk") {
        const outputChunk = chunk as RollupOutputChunk;
        if (outputChunk.facadeModuleId) {
          serverChunkSizes.set(
            outputChunk.facadeModuleId,
            Buffer.byteLength(outputChunk.code, "utf-8"),
          );
        }
      }
    }
  }

  // 5. Combine everything per route
  const routeSizes = new Map<string, RouteSizeInfo>();

  for (const [routeId, clientMods] of routeClientModules) {
    const routeSpecificClientSize = getRouteSpecificSize(clientMods);

    // Find server size: look through the chunks for one matching this route's component
    let serverSize = 0;
    for (const [facadeId, size] of serverChunkSizes) {
      // Match by route id in the facadeModuleId path
      if (facadeId.includes(`/${routeId}.`) || facadeId.endsWith(`/${routeId}`)) {
        serverSize = size;
        break;
      }
    }

    routeSizes.set(routeId, {
      serverSize,
      routeSpecificClientSize,
      firstLoadJS: sharedTotalBytes + routeSpecificClientSize,
    });
  }

  return {
    sharedSize: sharedTotalBytes,
    sharedGzipSize,
    sharedChunks,
    routes: routeSizes,
  };
}

// ---------------------------------------------------------------------------
// Match server chunks to routes using component file paths
// ---------------------------------------------------------------------------

/**
 * Build a map from route ID to server chunk size using actual component file paths.
 */
export function mapServerChunksToRoutes(
  routes: ParsedRoute[],
  routesDir: string,
  rscOutput: RollupOutput | RollupOutput[],
): Map<string, number> {
  const result = new Map<string, number>();
  const outputs = Array.isArray(rscOutput) ? rscOutput : [rscOutput];

  // Build facadeModuleId → chunk size map
  const chunksByFacade = new Map<string, number>();
  for (const output of outputs) {
    for (const chunk of output.output) {
      if (chunk.type === "chunk" && (chunk as RollupOutputChunk).facadeModuleId) {
        const oc = chunk as RollupOutputChunk;
        chunksByFacade.set(oc.facadeModuleId!, Buffer.byteLength(oc.code, "utf-8"));
      }
    }
  }

  function walkRoutes(routes: ParsedRoute[]) {
    for (const route of routes) {
      if (route.componentPath) {
        const componentFile = resolveModulePath(route.componentPath, routesDir);
        if (componentFile) {
          // Try exact match
          const size = chunksByFacade.get(componentFile);
          if (size !== undefined) {
            result.set(route.id, size);
          } else {
            // Try fuzzy match on path suffix
            for (const [facade, s] of chunksByFacade) {
              if (facade.endsWith(componentFile.split("/app/").pop() ?? "")) {
                result.set(route.id, s);
                break;
              }
            }
          }
        }
      }

      if (route.children) {
        walkRoutes(route.children);
      }
    }
  }

  walkRoutes(routes);
  return result;
}

// ---------------------------------------------------------------------------
// Print functions
// ---------------------------------------------------------------------------

export function printHeader(version: string): void {
  console.log("");
  console.log(c.bold(`  react-flight-router v${version}`));
  console.log("");
}

const MAX_PATH_COL = 45;

export function printRouteTable(
  flatRoutes: FlatRoute[],
  sizeData: BuildSizeData,
  serverSizes: Map<string, number>,
): void {
  const headerPad = " ".repeat(MAX_PATH_COL - 8);
  console.log(c.bold("  Routes") + headerPad + c.dim("Server") + "    " + c.dim("First Load JS"));
  console.log("");

  for (const route of flatRoutes) {
    const icon = route.isDynamic ? c.yellow("λ") : c.cyan("○");
    const routeSizeInfo = sizeData.routes.get(route.id);

    const serverSize = serverSizes.get(route.id) ?? 0;
    const firstLoadJS = routeSizeInfo?.firstLoadJS ?? sizeData.sharedSize;

    // Truncate long paths to fit within the column
    const prefixPlain = stripAnsi(route.treePrefix);
    const maxPathLen = MAX_PATH_COL - prefixPlain.length - 3; // 3 for "○ "
    let pathStr = route.fullPath;
    if (pathStr.length > maxPathLen && maxPathLen > 10) {
      pathStr = pathStr.slice(0, maxPathLen - 3) + "...";
    }

    const pathDisplay = `${route.treePrefix}${icon} ${pathStr}`;
    const plainPath = stripAnsi(pathDisplay);
    const pad = Math.max(1, MAX_PATH_COL - plainPath.length);

    const serverStr = serverSize > 0 ? formatSize(serverSize) : c.dim("0 B");
    const firstLoadStr = formatSize(firstLoadJS);

    console.log(
      `  ${pathDisplay}${" ".repeat(pad)}${serverStr.padStart(10)}  ${c.bold(firstLoadStr.padStart(12))}`,
    );
  }

  console.log("");
}

export function printSharedChunks(sizeData: BuildSizeData): void {
  console.log(
    `  ${c.dim("+")} First Load JS shared by all` +
      `          ${c.bold(formatSize(sizeData.sharedSize).padStart(10))}`,
  );

  // Show top 3 shared chunks individually, rest as "other"
  const topN = 3;
  const top = sizeData.sharedChunks.slice(0, topN);
  const rest = sizeData.sharedChunks.slice(topN);

  for (let i = 0; i < top.length; i++) {
    const chunk = top[i];
    const isLast = i === top.length - 1 && rest.length === 0;
    const prefix = isLast ? "└" : "├";
    const displayPath = truncatePath(chunk.path, 40);
    console.log(
      `    ${c.dim(prefix)} ${c.dim(displayPath)}${" ".repeat(Math.max(1, 42 - displayPath.length))}${c.dim(formatSize(chunk.size).padStart(10))}`,
    );
  }

  if (rest.length > 0) {
    const otherSize = rest.reduce((sum, ch) => sum + ch.size, 0);
    console.log(
      `    ${c.dim("└")} ${c.dim("other shared chunks (framework)")}${" ".repeat(10)}${c.dim(formatSize(otherSize).padStart(10))}`,
    );
  }

  console.log("");
}

export function printLegend(): void {
  console.log(`  ${c.cyan("○")} static   ${c.yellow("λ")} dynamic`);
  console.log("");
}

export function printModuleCounts(
  clientCount: number,
  serverCount: number,
  cssCount: number,
): void {
  const parts: string[] = [];
  if (clientCount > 0) parts.push(`${clientCount} client`);
  if (serverCount > 0) parts.push(`${serverCount} server actions`);
  if (cssCount > 0) parts.push(`${cssCount} css`);
  console.log(`  ${c.dim("Modules:")} ${parts.join(c.dim(", "))}`);
  console.log("");
}

export function printPhase(phase: number, label: string, durationMs: number): void {
  console.log(
    `  ${c.green("✓")} Phase ${phase}  ${label.padEnd(16)} ${c.dim(formatDuration(durationMs).padStart(8))}`,
  );
}

export function printBuildStart(): void {
  console.log(c.bold("  Build"));
  console.log("");
}

export function printOutputSummary(outDir: string, totalDurationMs: number): void {
  const files = collectOutputFiles(outDir, outDir);

  const categories: { label: string; filter: (f: OutputFile) => boolean; showGzip: boolean }[] = [
    {
      label: "server",
      filter: (f) =>
        f.path === "server.js" ||
        (f.path.startsWith("server/") && !f.path.startsWith("server/ssr/")),
      showGzip: false,
    },
    { label: "ssr", filter: (f) => f.path.startsWith("server/ssr/"), showGzip: false },
    {
      label: "client",
      filter: (f) => f.path.startsWith("client/") && !f.path.endsWith(".json"),
      showGzip: true,
    },
    { label: "manifests", filter: (f) => f.path.endsWith(".json"), showGzip: false },
  ];

  console.log("");
  console.log(
    c.bold("  Output") +
      "                                       " +
      c.dim("Size") +
      "       " +
      c.dim("Gzip"),
  );
  console.log("");

  for (const { label, filter, showGzip } of categories) {
    const catFiles = files.filter(filter);
    if (catFiles.length === 0) continue;
    const totalSize = catFiles.reduce((sum, f) => sum + f.size, 0);
    const jsFiles = catFiles.filter((f) => f.path.endsWith(".js"));
    const cssFiles = catFiles.filter((f) => f.path.endsWith(".css"));
    const jsonFiles = catFiles.filter((f) => f.path.endsWith(".json"));

    const parts: string[] = [];
    if (jsFiles.length > 0) parts.push(`${jsFiles.length} js`);
    if (cssFiles.length > 0) parts.push(`${cssFiles.length} css`);
    if (jsonFiles.length > 0) parts.push(`${jsonFiles.length} json`);

    let gzipStr = "";
    if (showGzip) {
      let gzipTotal = 0;
      for (const f of catFiles) {
        const fullPath = resolve(outDir, f.path);
        try {
          const content = readFileSync(fullPath);
          gzipTotal += gzipSync(content, { level: 1 }).length;
        } catch {
          // skip
        }
      }
      gzipStr = formatSize(gzipTotal).padStart(10);
    }

    console.log(
      `  ${label.padEnd(12)} ${c.dim(parts.join(", ").padEnd(20))} ${formatSize(totalSize).padStart(10)}${gzipStr ? "  " + c.dim(gzipStr) : ""}`,
    );
  }

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`  ${"─".repeat(55)}`);
  console.log(
    `  ${"total".padEnd(12)} ${c.dim(`${files.length} files`.padEnd(20))} ${formatSize(totalSize).padStart(10)}`,
  );
  console.log("");
  console.log(`  ${c.green("✓")} Done in ${c.bold(formatDuration(totalDurationMs))}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncatePath(p: string, maxLen: number = 40): string {
  if (p.length <= maxLen) return p;
  const ext = p.slice(p.lastIndexOf("."));
  const keep = maxLen - 3 - ext.length;
  if (keep < 5) return p.slice(0, maxLen - 3) + "...";
  return p.slice(0, keep) + "..." + ext;
}

// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "");
}
