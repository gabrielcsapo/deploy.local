import type { Plugin } from 'vite';

export type UseClientMode = 'rsc-server' | 'client' | 'ssr' | 'auto';

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
    name: 'flight-router:use-client',
    enforce: 'pre',

    transform(code: string, id: string, options?: { ssr?: boolean }) {
      if (!hasUseClientDirective(code)) return null;
      // Skip node_modules EXCEPT flight-router's own client components
      if (id.includes('node_modules') && !id.includes('flight-router')) return null;

      opts.onClientModule?.(id);

      const effectiveMode = opts.mode === 'auto'
        ? (options?.ssr ? 'rsc-server' : 'client')
        : opts.mode;

      if (effectiveMode === 'rsc-server') {
        return transformForRSCServer(code, id);
      }

      // In client/SSR mode, strip the directive but keep code
      return {
        code: code.replace(/^['"]use client['"];?\s*/m, ''),
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
    names.push('default');
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
    for (const part of inner.split(',')) {
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

  let proxyCode = `import { registerClientReference } from 'react-server-dom-webpack/server.node';\n`;

  for (const name of exportNames) {
    if (name === 'default') {
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
  // Handle flight-router library modules
  const frIndex = filePath.indexOf('flight-router/');
  if (frIndex !== -1) {
    return stripExtension(filePath.slice(frIndex));
  }
  // Find the 'app/' segment and use everything from there
  const appIndex = filePath.indexOf('/app/');
  if (appIndex !== -1) {
    const relative = filePath.slice(appIndex + 1);
    return stripExtension(relative);
  }
  // Fallback: use the filename
  return stripExtension(filePath.split('/').pop() ?? filePath);
}

function stripExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs)$/, '');
}
