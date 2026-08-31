import { defineConfig } from "vite";

/**
 * Vite configuration for Akasha frontend.
 *
 * Development:
 *   - Serves on port 5173 (Vite default)
 *   - Proxies /api requests to http://localhost:5175 (Express server)
 *   - Fast refresh on file change
 *
 * Production:
 *   - Bundles to ./dist/ (served by Express or Electron)
 *   - Chunk size warnings set to 1500 KB (web visualization is inherently large)
 */
export default defineConfig({
  server: {
    // Vite dev server port
    port: 5173,
    proxy: {
      // Proxy API requests to the Express backend (running on different port)
      "/api": "http://localhost:5175",
    },
  },
  build: {
    // Output directory for production builds
    outDir: "dist",
    // Visualization libraries (THREE.js, 3d-force-graph, etc.) are large;
    // warn only if chunk exceeds 1500 KB (default 500 KB would spam)
    chunkSizeWarningLimit: 1500,
  },
});
