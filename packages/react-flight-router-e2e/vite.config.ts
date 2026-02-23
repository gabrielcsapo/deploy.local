import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { flightRouter } from 'flight-router/dev';

export default defineConfig({
  plugins: [
    react(),
    flightRouter({ routesFile: './app/routes.ts' }),
  ],
});
