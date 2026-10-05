import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The dashboard is designed to run either
 *   • locally:  vite dev server on :5173 proxying /api + /ws to the bot on :4000
 *   • hosted:   behind an https reverse proxy / sandbox preview
 * `allowedHosts` and the optional wss HMR client keep the hosted preview
 * working (Vite blocks unknown Host headers by default).
 */
/* `process` is declared locally so the client tsconfig does not need @types/node. */
declare const process: { env: Record<string, string | undefined> };

const previewWss = process.env.VX_PREVIEW_WSS === '1';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    strictPort: false,
    allowedHosts: true,
    hmr: previewWss ? { protocol: 'wss', clientPort: 443 } : true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  preview: {
    port: 4173,
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});
