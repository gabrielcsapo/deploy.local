import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { flightRouter } from 'react-flight-router/dev';
import { readFileSync } from 'fs';

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {},
  plugins: [
    tailwindcss(),
    react(),
    flightRouter({ routesFile: './app/routes.ts' }) as PluginOption,
  ],
  preview: {
    port: 5173,
    allowedHosts: true,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:80',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:80',
        ws: true,
      },
      '/': {
        target: 'http://localhost:80',
        changeOrigin: true,
        bypass(req) {
          const host = req.headers.host || '';
          const hostname = host.split(':')[0];
          if (
            hostname.endsWith('.local') &&
            hostname !== 'deploy.local' &&
            hostname !== 'discover.local' &&
            hostname !== 'localhost'
          ) {
            return null;
          }
          return req.url;
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './app'),
    },
  },
  optimizeDeps: {
    exclude: ['better-sqlite3'],
  },
  server: {
    watch: {
      ignored: ['.deploy-data/**'],
    },
    allowedHosts: true,
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:80',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:80',
        ws: true,
      },
      '/': {
        target: 'http://localhost:80',
        changeOrigin: true,
        bypass(req) {
          const host = req.headers.host || '';
          const hostname = host.split(':')[0];
          if (
            hostname.endsWith('.local') &&
            hostname !== 'deploy.local' &&
            hostname !== 'discover.local' &&
            hostname !== 'localhost'
          ) {
            return null;
          }
          return req.url;
        },
      },
    },
  },
  publicDir: 'public',
});
