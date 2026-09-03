import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { PluginOption } from 'vite';
import { defineConfig } from 'vite';
import { resolve } from 'path';
import { flightRouter } from 'react-flight-router/dev';
import { readFileSync } from 'fs';
import { request as httpsRequest } from 'https';

const { version } = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));

function developmentApiProxy(): PluginOption {
  return {
    name: 'deploy-local-development-api-proxy',
    enforce: 'pre',
    configureServer(server) {
      // react-flight-router handles unknown URLs as application routes before
      // Vite's built-in proxy middleware runs. Forward API requests first so
      // JSON mutations (notably login) cannot become an HTML 404 response.
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();

        const proxyReq = httpsRequest(
          {
            hostname: '127.0.0.1',
            port: 8443,
            path: req.url,
            method: req.method,
            headers: req.headers,
            rejectUnauthorized: false,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on('error', next);
        req.pipe(proxyReq);
      });
    },
  };
}

export default defineConfig({
  clearScreen: false,
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {},
  plugins: [
    developmentApiProxy(),
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
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'wss://localhost:8443',
        ws: true,
        secure: false,
      },
      '^/(?!api(?:/|$)|ws(?:/|$))': {
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
  ssr: {
    external: ['better-sqlite3'],
  },
  server: {
    watch: {
      // Runtime volumes can contain hundreds of thousands of files. The
      // repository-relative pattern did not match Chokidar's absolute paths,
      // exhausting Linux's watcher limit before Vite could serve the app.
      ignored: ['**/.deploy-data/**'],
    },
    allowedHosts: true,
    host: true,
    proxy: {
      '/api': {
        target: 'https://localhost:8443',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'wss://localhost:8443',
        ws: true,
        secure: false,
      },
      '^/(?!api(?:/|$)|ws(?:/|$))': {
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
