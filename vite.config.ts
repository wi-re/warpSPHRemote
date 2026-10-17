import { defineConfig } from "vite";
export default defineConfig({
  root: "web",
  base: process.env.VITE_BASE_PATH || "./",
  worker: { format: "es" },
  build: { outDir: "../dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
});
