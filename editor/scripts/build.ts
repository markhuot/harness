// Bundles the editor for a web view: one IIFE (dist/editor.js) that exposes `HarnessEditor` on
// window with `mount`, `createEditor` and `createDiffEditor`. The iOS ticket embeds it in an HTML
// resource and wires `mount(window, post)` to its message handler.
import { build as esbuild } from "esbuild";
import { dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "..");

export async function build(outfile = join(root, "dist/editor.js")) {
  await esbuild({
    entryPoints: [join(root, "src/index.ts")],
    outfile,
    bundle: true,
    format: "iife",
    globalName: "HarnessEditor",
    platform: "browser",
    target: "safari16",
    minify: true,
    logLevel: "warning",
  });
  return outfile;
}

if (import.meta.main) console.log(await build());
