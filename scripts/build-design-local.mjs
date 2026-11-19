#!/usr/bin/env node
// Builds the Design page as `deploy design dev` serves it into dist/design-local: the web app's own
// Design page components (vite.design-local.config.ts), and the app's fonts beside them. The CLI
// build carries the result (scripts/build-cli.mjs); run from source, bin/design-local-assets.mjs
// reads it here.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

export function buildDesignLocal() {
  execFileSync(
    process.execPath,
    [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '-c', 'vite.design-local.config.ts'],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
    },
  );
  const fonts = resolve(ROOT, 'dist/design-local/fonts');
  mkdirSync(fonts, { recursive: true });
  for (const font of readdirSync(resolve(ROOT, 'public/fonts')))
    if (font.endsWith('.woff2'))
      copyFileSync(resolve(ROOT, 'public/fonts', font), resolve(fonts, font));
  return resolve(ROOT, 'dist/design-local');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildDesignLocal();
