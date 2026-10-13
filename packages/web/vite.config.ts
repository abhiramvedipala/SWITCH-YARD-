import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Served from localhost only; one bundle is simpler than chunking for a local tool.
    chunkSizeWarningLimit: 2000,
  },
});
