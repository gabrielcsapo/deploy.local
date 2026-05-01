import type { RSCClientManifest, ServerActionsManifest } from "../shared/types.js";
import { getModuleId } from "../build/plugin-use-client.js";

/**
 * State shared between the dev plugin and the manifest builders.
 * Held by reference so reassignments to `appRoot` after `configResolved`
 * are visible to the lazy lookup map rebuilds.
 */
export interface DevManifestState {
  clientModules: Set<string>;
  serverModules: Set<string>;
  appRoot: string;
}

/**
 * Create the dev-mode manifest builders for client components and server
 * actions. Backed by lazily-rebuilt Map<moduleId, entry> lookups instead
 * of linear scans, which matters when react-server-dom-webpack hits the
 * manifest once per client component reference per RSC render.
 *
 * The Maps invalidate when `state.clientModules.size` / `state.serverModules.size`
 * changes — both Sets are insertion-only in dev (modules are added on
 * transform, never removed), so size equality is a sufficient cache key.
 */
export function createDevManifests(state: DevManifestState): {
  clientManifest: RSCClientManifest;
  serverActionsManifest: ServerActionsManifest;
} {
  const clientLookup = new Map<
    string,
    { id: string; chunks: string[]; name: string; async: boolean }
  >();
  let clientLookupSize = -1;

  const serverLookup = new Map<string, string>();
  let serverLookupSize = -1;

  function rebuildClientLookup(): void {
    if (clientLookupSize === state.clientModules.size) return;
    clientLookup.clear();
    for (const mod of state.clientModules) {
      const moduleId = getModuleId(mod);
      const viteUrl = mod.startsWith(state.appRoot)
        ? mod.slice(state.appRoot.length)
        : "/@fs" + mod;
      clientLookup.set(moduleId, { id: viteUrl, chunks: [viteUrl], name: "*", async: true });
    }
    clientLookupSize = state.clientModules.size;
  }

  function rebuildServerLookup(): void {
    if (serverLookupSize === state.serverModules.size) return;
    serverLookup.clear();
    for (const mod of state.serverModules) {
      serverLookup.set(getModuleId(mod), mod);
    }
    serverLookupSize = state.serverModules.size;
  }

  const clientManifest = new Proxy({} as RSCClientManifest, {
    get(_target, key: string | symbol) {
      if (typeof key !== "string") return undefined;
      rebuildClientLookup();
      return clientLookup.get(key);
    },
  });

  const serverActionsManifest = new Proxy({} as ServerActionsManifest, {
    get(_target, key: string | symbol) {
      if (typeof key !== "string") return undefined;
      rebuildServerLookup();
      // key is "moduleId#exportName" (e.g., "app/routes/actions#addMessage")
      const hashIndex = key.indexOf("#");
      const moduleKey = hashIndex !== -1 ? key.slice(0, hashIndex) : key;
      const exportName = hashIndex !== -1 ? key.slice(hashIndex + 1) : "*";
      const modPath = serverLookup.get(moduleKey);
      if (!modPath) return undefined;
      return { id: modPath, name: exportName, chunks: [] };
    },
  });

  return { clientManifest, serverActionsManifest };
}

/**
 * Legacy linear-scan implementations, retained for benchmark comparison
 * in dev-manifest.test.ts. Not used in the plugin.
 *
 * @internal
 */
export function legacyBuildDevClientManifest(
  clientModules: Set<string>,
  rootDir: string,
): RSCClientManifest {
  return new Proxy({} as RSCClientManifest, {
    get(_target, key: string | symbol) {
      if (typeof key !== "string") return undefined;
      for (const mod of clientModules) {
        const moduleId = getModuleId(mod);
        if (moduleId === key) {
          const viteUrl = mod.startsWith(rootDir) ? mod.slice(rootDir.length) : "/@fs" + mod;
          return { id: viteUrl, chunks: [viteUrl], name: "*", async: true };
        }
      }
      return undefined;
    },
  });
}

/** @internal */
export function legacyBuildDevServerActionsManifest(
  serverModules: Set<string>,
): ServerActionsManifest {
  return new Proxy({} as ServerActionsManifest, {
    get(_target, key: string | symbol) {
      if (typeof key !== "string") return undefined;
      const hashIndex = key.indexOf("#");
      const moduleKey = hashIndex !== -1 ? key.slice(0, hashIndex) : key;
      const exportName = hashIndex !== -1 ? key.slice(hashIndex + 1) : "*";

      for (const mod of serverModules) {
        const moduleId = getModuleId(mod);
        if (moduleId === moduleKey) {
          return { id: mod, name: exportName, chunks: [] };
        }
      }
      return undefined;
    },
  });
}
