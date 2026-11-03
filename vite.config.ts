import { defineConfig } from 'vitest/config';

/**
 * The preview environment proxies the dev server, so we bind to 0.0.0.0 and
 * accept any host. The app itself is entirely client-side and makes no
 * cross-origin requests: artwork, fonts and icons are all served locally.
 */
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Fail loudly rather than silently drifting to 5174: the live preview is
    // wired to 5173, so a quiet port change looks like a dead app.
    strictPort: true,
    allowedHosts: true,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          muxer: ['mp4-muxer'],
          zip: ['fflate'],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30000,
  },
});
