/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Output `dist/` is what the Fastify static mount serves at `/`.
// Assets land under `assets/` (matches the middleware's auth-exempt
// prefix list at server/middleware.ts).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: false,
    target: "es2022",
    rollupOptions: {
      output: {
        // Hashed asset names so cache-busting comes for free.
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // During `vite dev` the React app talks to a real backend.
    proxy: {
      "/api": "http://127.0.0.1:7700",
      "/ws": {
        target: "ws://127.0.0.1:7700",
        ws: true,
      },
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
