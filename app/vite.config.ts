import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here + "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: here + "dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
  },
});
