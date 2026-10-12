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

if (import.meta.main) {
  // `--out <file>` writes the bundle somewhere else (the iOS build puts it in the app's resources).
  const i = process.argv.indexOf("--out");
  const out = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !out) throw new Error("--out needs a file path");
  console.log(await build(out));
}
