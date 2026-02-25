import type { Plugin } from "vite";

export type UseClientMode = "rsc-server" | "client" | "ssr" | "auto";

interface UseClientPluginOptions {
  mode: UseClientMode;
  /** Called when a 'use client' module is discovered */
  onClientModule?: (id: string) => void;
}

/**
 * Vite plugin that transforms 'use client' files.
 *
 * In RSC server mode: replaces file with registerClientReference proxies.
 * In client/SSR mode: strips the directive (code remains as-is).
 * In auto mode: uses Vite's options.ssr flag to determine behavior.
 */
export function useClientPlugin(opts: UseClientPluginOptions): Plugin {
  return {
    name: "react-flight-router:use-client",
    enforce: "pre",

    // Preserve and propagate ?ssr query through the module resolution chain.
    // When ssrLoadModule loads a module with ?ssr, this hook ensures:
    // 1. The ?ssr query survives Vite's module resolution (top-level calls)
    // 2. All transitive local imports also get ?ssr (propagation)
    async resolveId(source, importer, options) {
      if (opts.mode !== "auto") return null;

      const sourceHasSSR = source.includes("?ssr") || source.includes("&ssr");
      const importerHasSSR = importer && (importer.includes("?ssr") || importer.includes("&ssr"));
      if (!sourceHasSSR && !importerHasSSR) return null;

      const cleanSource = source.replace(/[?&]ssr\b/, "");
      const cleanImporter = importer ? importer.replace(/[?&]ssr\b/, "") : undefined;
      const resolved = await this.resolve(cleanSource, cleanImporter, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external) return resolved;
      // Only propagate to local file paths (not external packages)
      if (resolved.id.startsWith("/")) {
        return { ...resolved, id: resolved.id + "?ssr" };
      }
      return resolved;
    },

    transform(code: string, id: string, options?: { ssr?: boolean }) {
      if (!hasUseClientDirective(code)) return null;
      // Skip node_modules EXCEPT react-flight-router's own client components
      if (id.includes("node_modules") && !id.includes("react-flight-router")) return null;

      // ?ssr query param forces real code (not proxies) for dev SSR rendering
      const isSSRReal = id.includes("?ssr") || id.includes("&ssr");
      const effectiveMode =
        opts.mode === "auto"
          ? isSSRReal
            ? "ssr"
            : options?.ssr
              ? "rsc-server"
              : "client"
          : opts.mode;
      // Only track client modules in RSC server mode (for the client manifest)
      if (effectiveMode === "rsc-server") {
        opts.onClientModule?.(id);
      }

      if (effectiveMode === "rsc-server") {
        return transformForRSCServer(code, id);
      }

      // In client/SSR mode, strip the directive but keep code
      return {
        code: code.replace(/^['"]use client['"];?\s*/m, ""),
        map: null,
      };
    },
  };
}

function hasUseClientDirective(code: string): boolean {
  return /^['"]use client['"];?/m.test(code.trimStart());
}

/**
 * Extract export names from source code using regex.
 * Works on TSX/JSX files without needing a full parser.
 */
export function extractExportNames(code: string): string[] {
  const names: string[] = [];

  // Match: export default function/class/expression
  if (/export\s+default\s+/m.test(code)) {
    names.push("default");
  }

  // Match: export function Name, export class Name
  const funcClassRegex = /export\s+(?:async\s+)?(?:function|class)\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = funcClassRegex.exec(code)) !== null) {
    names.push(match[1]);
  }

  // Match: export const/let/var Name
  const varRegex = /export\s+(?:const|let|var)\s+(\w+)/g;
  while ((match = varRegex.exec(code)) !== null) {
    names.push(match[1]);
  }

  // Match: export { Name, Name2 as Alias }
  const reExportRegex = /export\s*\{([^}]+)\}/g;
  while ((match = reExportRegex.exec(code)) !== null) {
    const inner = match[1];
    for (const part of inner.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      // Handle "Name as Alias" — the exported name is the alias
      const asMatch = trimmed.match(/\w+\s+as\s+(\w+)/);
      if (asMatch) {
        names.push(asMatch[1]);
      } else {
        names.push(trimmed.split(/\s/)[0]);
      }
    }
  }

  // Deduplicate
  return [...new Set(names)];
}

/**
 * In RSC server mode, replace the entire file with registerClientReference proxies.
 * This makes the RSC renderer emit client component references in the Flight stream.
 */
function transformForRSCServer(code: string, id: string): { code: string; map: null } {
  const exportNames = extractExportNames(code);
  const moduleId = getModuleId(id);

  let proxyCode = `import { registerClientReference } from 'virtual:rsc-runtime';\n`;

  for (const name of exportNames) {
    if (name === "default") {
      proxyCode += `export default registerClientReference(function() { throw new Error("Cannot call client component on server"); }, ${JSON.stringify(moduleId)}, "default");\n`;
    } else {
      proxyCode += `export const ${name} = registerClientReference(function() { throw new Error("Cannot call client component on server"); }, ${JSON.stringify(moduleId)}, ${JSON.stringify(name)});\n`;
    }
  }

  return { code: proxyCode, map: null };
}

/**
 * Normalize a file path to a stable module ID.
 * Strips the file extension and makes it relative.
 */
export function getModuleId(filePath: string): string {
  // For node_modules packages, skip the /app/ check — it can falsely match
  // when the project root is /app (e.g., Docker WORKDIR), causing paths like
  // /app/node_modules/.pnpm/react-flight-router/dist/client/router-context.tsx
  // to match /app/ instead of the react-flight-router/ handler.
  if (!filePath.includes("/node_modules/")) {
    // Check /app/ for app route files. This must come before the
    // react-flight-router/ check because in CI the repo may be named
    // "react-flight-router", causing app paths to falsely match.
    const appIndex = filePath.indexOf("/app/");
    if (appIndex !== -1) {
      const relative = filePath.slice(appIndex + 1);
      return stripExtension(relative);
    }
  }
  // Handle react-flight-router library modules.
  // Use lastIndexOf to avoid matching repo/workspace directory names.
  const frIndex = filePath.lastIndexOf("react-flight-router/");
  if (frIndex !== -1) {
    return stripExtension(filePath.slice(frIndex));
  }
  // Fallback: use the filename
  return stripExtension(filePath.split("/").pop() ?? filePath);
}

function stripExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}
