import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { flightRouter } from 'flight-router/dev';

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    flightRouter({ routesFile: './app/routes.ts' }),
  ],
});
