import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { getModuleId } from "./plugin-use-client.js";
import type { RSCClientManifest, SSRManifest, ServerActionsManifest } from "../shared/types.js";

interface ViteManifestEntry {
  file: string;
  name?: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
}

type ViteManifest = Record<string, ViteManifestEntry>;

interface GenerateManifestsOptions {
  outDir: string;
  appDir: string;
  clientModules: Set<string>;
  serverModules: Set<string>;
}

/**
 * Read Vite's build manifests and generate the three runtime manifests
 * needed by react-server-dom-webpack.
 */
export function generateManifests(opts: GenerateManifestsOptions): void {
  const clientManifestPath = resolve(opts.outDir, "client/.vite/manifest.json");
  const viteManifest: ViteManifest = JSON.parse(readFileSync(clientManifestPath, "utf-8"));

  const rscClientManifest = generateRSCClientManifest(
    viteManifest,
    opts.clientModules,
    opts.appDir,
  );
  const ssrManifest = generateSSRManifest(opts.clientModules);
  const serverActionsManifest = generateServerActionsManifest(opts.serverModules);

  // Collect all CSS files from the client build
  // Vite manifest file paths already include the output prefix (e.g. assets/)
  const cssFiles: string[] = [];
  for (const entry of Object.values(viteManifest)) {
    // CSS referenced by JS entries (e.g., CSS modules imported in client components)
    if (entry.css) {
      cssFiles.push(...entry.css.map((f) => `/${f}`));
    }
    // CSS-only entries (e.g., global stylesheets added as build inputs)
    if (entry.file.endsWith(".css")) {
      cssFiles.push(`/${entry.file}`);
    }
  }

  // Find the client entry URL by checking key, name, and src fields
  const clientEntryKey = Object.keys(viteManifest).find(
    (k) =>
      viteManifest[k].isEntry &&
      (k.includes("entry-client") ||
        k.includes("entry.js") ||
        viteManifest[k].name === "entry-client"),
  );
  const clientEntryUrl = clientEntryKey ? `/${viteManifest[clientEntryKey].file}` : "";

  writeFileSync(
    resolve(opts.outDir, "rsc-client-manifest.json"),
    JSON.stringify(rscClientManifest, null, 2),
  );

  writeFileSync(resolve(opts.outDir, "ssr-manifest.json"), JSON.stringify(ssrManifest, null, 2));

  writeFileSync(
    resolve(opts.outDir, "server-actions-manifest.json"),
    JSON.stringify(serverActionsManifest, null, 2),
  );

  writeFileSync(
    resolve(opts.outDir, "build-meta.json"),
    JSON.stringify({ clientEntryUrl, cssFiles }, null, 2),
  );
}

function generateRSCClientManifest(
  viteManifest: ViteManifest,
  clientModules: Set<string>,
  appDir: string,
): RSCClientManifest {
  const manifest: RSCClientManifest = {};

  for (const mod of clientModules) {
    const moduleId = getModuleId(mod);

    // Find this module in the Vite manifest
    const viteEntry = findViteEntry(viteManifest, mod, moduleId, appDir);
    if (!viteEntry) continue;

    // Build chunks array as pairs: [chunkId, chunkUrl, ...]
    // Vite manifest file paths already include the output prefix (e.g. assets/)
    const chunks: string[] = [];
    chunks.push(viteEntry.file, `/${viteEntry.file}`);

    for (const imp of viteEntry.imports ?? []) {
      const depEntry = viteManifest[imp];
      if (depEntry) {
        chunks.push(depEntry.file, `/${depEntry.file}`);
      }
    }

    manifest[moduleId] = {
      id: moduleId,
      chunks,
      name: "*",
      async: true,
    };
  }

  return manifest;
}

function generateSSRManifest(clientModules: Set<string>): SSRManifest {
  const moduleMap: SSRManifest["moduleMap"] = {};

  for (const mod of clientModules) {
    const moduleId = getModuleId(mod);
    moduleMap[moduleId] = {
      "*": {
        id: `./ssr/${moduleId}.js`,
        chunks: [],
        name: "*",
      },
    };
  }

  return {
    moduleMap,
    serverModuleMap: {},
    moduleLoading: { prefix: "/assets/" },
  };
}

function generateServerActionsManifest(serverModules: Set<string>): ServerActionsManifest {
  const manifest: ServerActionsManifest = {};

  for (const mod of serverModules) {
    const moduleId = getModuleId(mod);
    manifest[moduleId] = {
      id: moduleId,
      name: "*",
      chunks: [],
    };
  }

  return manifest;
}

function findViteEntry(
  viteManifest: ViteManifest,
  filePath: string,
  moduleId: string,
  appDir?: string,
): ViteManifestEntry | undefined {
  // Try exact match first
  if (viteManifest[filePath]) return viteManifest[filePath];
  if (viteManifest[moduleId]) return viteManifest[moduleId];

  // Try exact match with common extensions.
  // Vite manifest keys include the file extension (e.g. "app/routes/discover.tsx")
  // while moduleId has it stripped (e.g. "app/routes/discover"). Match with extension
  // to avoid "app/routes/discover" matching "app/routes/discover-index.tsx".
  const extensions = [".tsx", ".ts", ".jsx", ".js"];
  for (const ext of extensions) {
    if (viteManifest[moduleId + ext]) return viteManifest[moduleId + ext];
  }

  // Try partial match as fallback, but ensure the match is at a word boundary
  // (followed by "." for extension or end of string) to prevent
  // "app/routes/discover" from matching "app/routes/discover-index.tsx"
  for (const [key, entry] of Object.entries(viteManifest)) {
    if (matchesAtBoundary(key, moduleId) || (entry.src && matchesAtBoundary(entry.src, moduleId))) {
      return entry;
    }
  }

  // Try resolving relative manifest keys (e.g. "../../packages/ui/src/component.tsx")
  // against appDir and comparing with the absolute file path. This handles workspace
  // packages that live outside the app directory.
  if (appDir) {
    const strip = (p: string) => p.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
    const normalizedFilePath = strip(filePath);
    for (const [key, entry] of Object.entries(viteManifest)) {
      const resolved = strip(resolve(appDir, key));
      if (resolved === normalizedFilePath) {
        return entry;
      }
    }
  }

  return undefined;
}

/**
 * Check if `text` contains `moduleId` followed by a file extension boundary
 * (i.e., "." or end of string), preventing partial prefix matches like
 * "app/routes/discover" matching "app/routes/discover-index.tsx".
 */
function matchesAtBoundary(text: string, moduleId: string): boolean {
  const idx = text.indexOf(moduleId);
  if (idx === -1) return false;
  const afterIdx = idx + moduleId.length;
  if (afterIdx >= text.length) return true;
  // Must be followed by "." (file extension) to be an exact module match
  return text[afterIdx] === ".";
}
