import type { Plugin } from "vite";

/**
 * Tracks files with 'use client' directive during the RSC build.
 * After the build, collectedModules contains all client component file paths.
 */
export function collectClientModulesPlugin(): Plugin & { collectedModules: Set<string> } {
  const collectedModules = new Set<string>();

  return {
    name: "flight-router:collect-client-modules",
    collectedModules,

    transform(code: string, id: string) {
      if (id.includes("node_modules")) return null;
      if (/^['"]use client['"];?/m.test(code.trimStart())) {
        collectedModules.add(id);
      }
      return null;
    },
  };
}
