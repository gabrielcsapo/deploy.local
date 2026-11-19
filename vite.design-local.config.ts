// The Design page as `deploy design dev` serves it: the same components, built to static files
// the CLI carries (scripts/build-design-local.mjs), reading a folder through the local design API.
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  root: resolve(import.meta.dirname, 'app/design-local'),
  base: './',
  clearScreen: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: [
      { find: '@', replacement: resolve(import.meta.dirname, './app') },
      {
        find: /^react-flight-router\/client$/,
        replacement: resolve(import.meta.dirname, 'app/design-local/router-shim.tsx'),
      },
    ],
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist/design-local'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
  },
});
