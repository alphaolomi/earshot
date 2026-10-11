import { defineConfig } from "vite";

// Relative base so the build works from any subpath (e.g. GitHub Pages).
export default defineConfig({
  base: "./",
  worker: { format: "es" },
  build: { target: "es2022" },
});
