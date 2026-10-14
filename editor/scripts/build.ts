// Bundles the editor for a web view: one IIFE (dist/editor.js) that exposes `HarnessEditor` on
// window with `mount`, `createEditor` and `createDiffEditor`. The iOS app embeds it in an HTML
// resource and wires `mount(window, post)` to its message handler.
//
// An IIFE can't split code, so Shiki's grammars and themes would all land in it (about 10 MB).
// They're imported on demand, so the plugin below swaps every grammar and theme the editor doesn't
// list (BUNDLED_LANGUAGES, the app themes' syntax themes) for an empty module and drops the WASM
// regex engine (@pierre/diffs uses the JavaScript one by default).
import { build as esbuild, type Plugin } from "esbuild";
import { dirname, join } from "node:path";
import { THEMES } from "@harness/shared/themes";
import { BUNDLED_LANGUAGES } from "../src/language";

const root = join(dirname(import.meta.path), "..");

/** Shiki themes the app's themes name; Pierre's own come from @pierre/theming. */
export const BUNDLED_SYNTAX_THEMES: readonly string[] = [...new Set(THEMES.map((t) => t.syntaxTheme).filter((n): n is string => !!n))];

export function trimShiki(langs: readonly string[] = BUNDLED_LANGUAGES, themes: readonly string[] = BUNDLED_SYNTAX_THEMES): Plugin {
  const keep = { langs: new Set(langs), themes: new Set(themes) };
  return {
    name: "trim-shiki",
    setup(b) {
      b.onResolve({ filter: /^@shikijs\/(langs|themes)\// }, (args) => {
        // Only the on-demand imports; a grammar another one embeds is a static import and stays.
        if (args.kind !== "dynamic-import") return;
        const [, kind, name] = args.path.match(/^@shikijs\/(langs|themes)\/(.+)$/)!;
        if (keep[kind as "langs" | "themes"].has(name!)) return;
        return { path: args.path, namespace: "empty" };
      });
      b.onResolve({ filter: /^shiki\/wasm$/ }, (args) => ({ path: args.path, namespace: "empty" }));
      b.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export default []", loader: "js" }));
    },
  };
}

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
    plugins: [trimShiki()],
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
