import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Only dedupe the packages where instanceof checks cross module boundaries.
// Do NOT include @codemirror/language — basic-setup@0.20.x ships an
// incompatible 0.x version that must stay separate from the 6.x copy.
const CODEMIRROR_DEDUPE = [
  "@codemirror/state",
  "@codemirror/view",
];

// Pre-bundle the packages we directly import so the dep optimizer
// doesn't produce separate CJS shims for the same package.
const CODEMIRROR_PREBUNDLE = [
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/lang-markdown",
  "@codemirror/lang-json",
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force Vite to resolve @codemirror/state and @codemirror/view to a
    // single instance. Without this, basic-setup (0.20.x peer range) and
    // the direct ^6.x deps can each get a separate module copy in Vite's
    // ESM graph, breaking EditorState instanceof checks at runtime.
    dedupe: CODEMIRROR_DEDUPE,
  },
  optimizeDeps: {
    // Pre-bundle into a single chunk so the dep optimizer doesn't produce
    // separate CJS shims for the same package.
    include: CODEMIRROR_PREBUNDLE,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8765",
        changeOrigin: false,
      },
    },
  },
});
