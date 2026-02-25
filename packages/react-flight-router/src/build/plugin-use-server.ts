import type { Plugin } from "vite";
import { getModuleId, extractExportNames } from "./plugin-use-client.js";

export type UseServerMode = "rsc-server" | "client" | "ssr" | "auto";

interface UseServerPluginOptions {
  mode: UseServerMode;
  /** Called when a 'use server' module is discovered */
  onServerModule?: (id: string) => void;
}

/**
 * Vite plugin that transforms 'use server' files.
 *
 * In RSC server mode: wraps exports with registerServerReference.
 * In client mode: replaces with createServerReference stubs.
 * In SSR mode: same as client mode.
 * In auto mode: uses Vite's options.ssr flag to determine behavior.
 */
export function useServerPlugin(opts: UseServerPluginOptions): Plugin {
  return {
    name: "react-flight-router:use-server",
    enforce: "pre",

    transform(code: string, id: string, options?: { ssr?: boolean }) {
      if (!hasUseServerDirective(code)) return null;
      if (id.includes("node_modules")) return null;

      opts.onServerModule?.(id);

      const effectiveMode =
        opts.mode === "auto" ? (options?.ssr ? "rsc-server" : "client") : opts.mode;

      if (effectiveMode === "rsc-server") {
        return transformForRSCServer(code, id);
      }

      // Client and SSR mode: replace with server reference stubs
      return transformForClient(code, id);
    },
  };
}

function hasUseServerDirective(code: string): boolean {
  return /^['"]use server['"];?/m.test(code.trimStart());
}

/**
 * In RSC server mode, keep the original code but wrap each export
 * with registerServerReference so the Flight protocol can serialize them.
 * Also registers exports in a global registry so the production server
 * can look them up by module ID without needing separate chunk files.
 */
function transformForRSCServer(code: string, id: string): { code: string; map: null } {
  const exportNames = extractExportNames(code);
  const moduleId = getModuleId(id);

  // Strip the directive
  let transformed = code.replace(/^['"]use server['"];?\s*/m, "");

  // Add registration calls at the end
  transformed += `\nimport { registerServerReference as __rsr } from 'react-server-dom-webpack/server.node';\n`;

  for (const name of exportNames) {
    if (name !== "default") {
      transformed += `__rsr(${name}, ${JSON.stringify(moduleId)}, ${JSON.stringify(name)});\n`;
    }
  }

  // Register in global module registry so the production server can look up
  // action modules by ID. Rollup may inline these modules into other chunks,
  // so we can't rely on separate files existing at predictable paths.
  transformed += `\nif (!globalThis.__flight_server_modules) globalThis.__flight_server_modules = {};\n`;
  transformed += `if (!globalThis.__flight_server_modules[${JSON.stringify(moduleId)}]) globalThis.__flight_server_modules[${JSON.stringify(moduleId)}] = {};\n`;

  for (const name of exportNames) {
    if (name !== "default") {
      transformed += `globalThis.__flight_server_modules[${JSON.stringify(moduleId)}][${JSON.stringify(name)}] = ${name};\n`;
    }
  }

  return { code: transformed, map: null };
}

/**
 * In client/SSR mode, replace the entire file with stubs that call
 * createServerReference. These stubs serialize the action ID and args,
 * then POST to the server's action endpoint.
 */
function transformForClient(code: string, id: string): { code: string; map: null } {
  const exportNames = extractExportNames(code);
  const moduleId = getModuleId(id);

  let proxyCode = `import { createServerReference } from 'react-server-dom-webpack/client.browser';\n`;
  proxyCode += `import { callServer } from 'react-flight-router/client';\n`;

  for (const name of exportNames) {
    const actionId = `${moduleId}#${name}`;
    if (name === "default") {
      proxyCode += `export default createServerReference(${JSON.stringify(actionId)}, callServer);\n`;
    } else {
      proxyCode += `export const ${name} = createServerReference(${JSON.stringify(actionId)}, callServer);\n`;
    }
  }

  return { code: proxyCode, map: null };
}
