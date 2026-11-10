import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Astryx, the UI's design system, needs browsers from 2024 on (CSS light-dark(), cascade layers,
// @scope, the Popover API): Chrome and Edge 123+, Firefox 125+, Safari 17.5+.
const TARGETS = ["chrome123", "edge123", "firefox125", "safari17.5"];

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: TARGETS, cssTarget: TARGETS, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:3000", changeOrigin: false } },
  },
});
