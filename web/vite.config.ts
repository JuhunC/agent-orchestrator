import legacy from "@vitejs/plugin-legacy";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Older browsers get a separate transpiled, polyfilled bundle (loaded via <script nomodule>
// or when modern ES features are missing), so the admin UI works there too.
const LEGACY_TARGETS = ["chrome >= 61", "edge >= 79", "firefox >= 60", "safari >= 11", "ios >= 11", "samsung >= 8"];

export default defineConfig({
  root: "web",
  plugins: [
    react(),
    legacy({
      targets: LEGACY_TARGETS,
      // Browsers that load ES modules but predate ?. and ?? (e.g. Chrome 64-79, Safari 12-13)
      // run the modern bundle, so it must be transpiled down for them too.
      modernTargets: ["chrome >= 64", "edge >= 79", "firefox >= 67", "safari >= 12", "ios >= 12", "samsung >= 9"],
      // Also polyfill the modern bundle for browsers that run ES modules but lack newer APIs.
      modernPolyfills: true,
      renderLegacyChunks: true,
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true, cssTarget: ["chrome61", "edge79", "firefox60", "safari11"] },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
});
