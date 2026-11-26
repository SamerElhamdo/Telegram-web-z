import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const DIR_NAME = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(DIR_NAME, 'console'),
  base: '/console/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  build: {
    outDir: resolve(DIR_NAME, 'dist/console'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '127.0.0.1',
    port: 1235,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/mcp': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/readyz': 'http://127.0.0.1:8787',
    },
  },
});
