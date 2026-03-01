import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { resolve } from 'path';
import { copyFileSync, readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

function copy404(): Plugin {
  return {
    name: 'copy-404',
    writeBundle(options) {
      copyFileSync(resolve(__dirname, 'docs-site', '404.html'), resolve(options.dir!, '404.html'));
    },
  };
}

export default defineConfig({
  root: 'docs-site',
  base: '/deploy.sh/',
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: resolve(__dirname, 'dist-docs'),
    emptyOutDir: true,
    minify: false,
  },
  plugins: [tailwindcss(), react(), copy404()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './app'),
    },
  },
  publicDir: resolve(__dirname, 'public'),
});
