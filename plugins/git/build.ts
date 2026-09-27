// Bundle the Changes UI (ui/index.html → dist/). Run: bun run build (or `bun run plugins:build` at the repo root).
import { renameSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const dist = join(here, "dist");
// Build next to dist and swap it in, so a concurrent reader (or build) never sees a half-written bundle.
const outdir = join(here, `.dist-${process.pid}`);
rmSync(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(here, "ui", "index.html")],
  outdir,
  target: "browser",
  minify: true,
  splitting: true,
  sourcemap: "none",
  naming: { entry: "[name].[ext]", chunk: "chunks/[name]-[hash].[ext]", asset: "assets/[name]-[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  rmSync(outdir, { recursive: true, force: true });
  process.exit(1);
}
const bytes = result.outputs.reduce((n, o) => n + o.size, 0);
rmSync(dist, { recursive: true, force: true });
renameSync(outdir, dist);
console.log(`git plugin UI → ${dist} (${result.outputs.length} files, ${(bytes / 1024).toFixed(0)} KiB)`);
