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
    // ghostty-web (terminal panes) is a lazy chunk of ~650 KB, most of it its WASM core inlined as a
    // data: URL, which it fetches from memory; that works from file:// and inside the asar with no
    // asset to locate. It only loads when the first terminal opens. Shiki's grammars (code blocks,
    // via @pierre/diffs) are lazy chunks too, one per language, loaded when a fence names it; the
    // largest (emacs-lisp, cpp) are just under 800 KB.
    chunkSizeWarningLimit: 800,
  },
});
