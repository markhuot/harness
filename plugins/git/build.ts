// Bundle the Changes UI (ui/main.ts → dist/). Run: bun run build (or `bun run plugins:build` at the
// repo root); the service also runs it when dist/ is missing or stale (plugin.json "build").
//
// The JS entry is bundled directly and index.html is written here: with code splitting, Bun's HTML
// entrypoints sometimes point <script src> at the wrong chunk (Shiki ships many), so we don't use them.
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dir;
const dist = join(here, "dist");
// Build next to dist and swap it in, so a concurrent reader (or build) never sees a half-written bundle.
const outdir = join(here, `.dist-${process.pid}`);
rmSync(outdir, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(here, "ui", "main.ts")],
  outdir,
  target: "browser",
  minify: true,
  splitting: true,
  sourcemap: "none",
  naming: { entry: "[name].[ext]", chunk: "chunks/[hash].[ext]", asset: "assets/[hash].[ext]" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  rmSync(outdir, { recursive: true, force: true });
  process.exit(1);
}
const css = result.outputs.some((o) => o.path.endsWith("/main.css"));
writeFileSync(
  join(outdir, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Changes</title>
    ${css ? '<link rel="stylesheet" href="./main.css" />' : ""}
    <script type="module" src="./main.js"></script>
  </head>
  <body>
    <div id="app" class="app"></div>
  </body>
</html>
`,
);
const bytes = result.outputs.reduce((n, o) => n + o.size, 0);
rmSync(dist, { recursive: true, force: true });
renameSync(outdir, dist);
console.log(`git plugin UI → ${dist} (${result.outputs.length + 1} files, ${(bytes / 1024).toFixed(0)} KiB)`);
