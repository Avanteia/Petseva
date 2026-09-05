import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'RMS POS',
        short_name: 'RMS POS',
        description: 'Restaurant point of sale — offline capable',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        // App shell is precached; API data lives in IndexedDB (Dexie), not the HTTP cache.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    // Consume the shared package from source so Vite handles TS + tree-shaking (and HMR in dev).
    alias: { '@rms/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'http://localhost:4000', ws: true },
    },
  },
  build: { sourcemap: false },
});
