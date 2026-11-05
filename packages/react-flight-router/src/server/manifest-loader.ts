import { readFileSync } from "fs";
import { resolve } from "path";
import type {
  Manifests,
  RSCClientManifest,
  SSRManifest,
  ServerActionsManifest,
} from "../shared/types.js";

/**
 * Load all build manifests from the dist directory.
 * Called once at server startup.
 */
export function loadManifests(buildDir: string): Manifests {
  const rscClientManifest: RSCClientManifest = JSON.parse(
    readFileSync(resolve(buildDir, "rsc-client-manifest.json"), "utf-8"),
  );

  const ssrManifest: SSRManifest = JSON.parse(
    readFileSync(resolve(buildDir, "ssr-manifest.json"), "utf-8"),
  );

  const serverActionsManifest: ServerActionsManifest = JSON.parse(
    readFileSync(resolve(buildDir, "server-actions-manifest.json"), "utf-8"),
  );

  const buildMeta: { clientEntryUrl: string; cssFiles: string[] } = JSON.parse(
    readFileSync(resolve(buildDir, "build-meta.json"), "utf-8"),
  );

  return {
    rscClientManifest,
    ssrManifest,
    serverActionsManifest,
    clientEntryUrl: buildMeta.clientEntryUrl,
    cssFiles: buildMeta.cssFiles,
  };
}
