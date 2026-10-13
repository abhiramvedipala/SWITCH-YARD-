import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` only: Vite serves the UI with HMR and proxies the API, the bus and the socket to core.
// Core must still see a plain local request: changeOrigin sends core's own loopback Host, and xfwd stays off
// (the default), because any x-forwarded-* header makes core treat the request as remote (Tailscale identity).
const core = `http://127.0.0.1:${process.env.SWITCHYARD_PORT ?? 4777}`;
const toCore = { target: core, changeOrigin: true, xfwd: false };

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // never 0.0.0.0
    port: 5173,
    strictPort: true, // fail instead of moving to another port: the printed dev URL stays true
    proxy: { '/api': toCore, '/bus': toCore, '/ws': { ...toCore, ws: true } },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Served from localhost only; one bundle is simpler than chunking for a local tool.
    chunkSizeWarningLimit: 2000,
  },
});
