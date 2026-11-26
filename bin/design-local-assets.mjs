// What `deploy design dev` serves besides the folder: the Design page built to static files
// (pnpm build:design-local writes dist/design-local) and deploy.local's own design system, for a
// project with no design/ds. The CLI build carries both (scripts/build-cli.mjs); run from source,
// they are read from this checkout.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/* global __DESIGN_LOCAL_ASSETS__, __DESIGN_SYSTEM_FILES__, __DESIGN_STARTER_FILES__ */

/** Every file under a folder, as { "relative/path": Buffer }. */
export function readTree(folder) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile())
        files[relative(folder, path).replaceAll('\\', '/')] = readFileSync(path);
    }
  };
  if (existsSync(folder)) walk(folder);
  return files;
}

const decode = (text) =>
  Object.fromEntries(
    Object.entries(JSON.parse(text)).map(([path, base64]) => [path, Buffer.from(base64, 'base64')]),
  );
const source = resolve(import.meta.dirname, '..');

/** The built Design page, or null when this checkout has not built it. */
export function designLocalAssets() {
  if (typeof __DESIGN_LOCAL_ASSETS__ !== 'undefined') return decode(__DESIGN_LOCAL_ASSETS__);
  const files = readTree(join(source, 'dist/design-local'));
  return files['index.html'] ? files : null;
}

/** deploy.local's design system, by its path under design/ ("ds/deploy-local/tokens.css"). */
export function designSystemFiles() {
  if (typeof __DESIGN_SYSTEM_FILES__ !== 'undefined') return decode(__DESIGN_SYSTEM_FILES__);
  return Object.fromEntries(
    Object.entries(readTree(join(source, 'design/ds/deploy-local'))).map(([path, bytes]) => [
      `ds/deploy-local/${path}`,
      bytes,
    ]),
  );
}

/**
 * The starter design system deploy design init copies into a new project, by its path inside the
 * starter ("tokens.css", "examples/Page.html"). Empty until the CLI carries one.
 */
export function designStarterFiles() {
  if (typeof __DESIGN_STARTER_FILES__ !== 'undefined') return decode(__DESIGN_STARTER_FILES__);
  return readTree(join(source, 'bin/design-starter'));
}
