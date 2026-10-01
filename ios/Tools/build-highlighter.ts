// Bundles the syntax highlighter for JavaScriptCore (ios/Tools/highlighter/entry.ts: Shiki core, its
// JavaScript regex engine, and exactly the RN app's languages and themes, taken from
// mobile/src/lib/highlight.ts) into one classic script that defines the `HarnessHighlighter` global.
//
//   bun ios/Tools/build-highlighter.ts [--out <file>]
//
// The output is generated, not committed (ARCHITECTURE.md § Syntax highlighting): the app target's
// "Bundle highlighter" build phase writes it into Harness.app, and the HarnessKit tests build it
// into ios/build/highlighter/ (HighlighterScript.swift). Without code splitting, Bun keeps each
// grammar and theme as a lazily evaluated module inside the one file, so loading the script only
// parses it; a language costs its evaluation the first time a block uses it.

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const DEFAULT_OUT = resolve(ROOT, "ios/build/highlighter/highlighter.js");

export async function buildHighlighter(out = DEFAULT_OUT): Promise<{ out: string; bytes: number; ms: number }> {
  const started = performance.now();
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "highlighter/entry.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    splitting: false,
  });
  if (!result.success) throw new AggregateError(result.logs, "build-highlighter: bundling failed");
  const [artifact] = result.outputs;
  if (!artifact || result.outputs.length !== 1) throw new Error(`build-highlighter: expected one output, got ${result.outputs.length}`);
  mkdirSync(dirname(out), { recursive: true });
  await Bun.write(out, artifact);
  return { out, bytes: statSync(out).size, ms: Math.round(performance.now() - started) };
}

if (import.meta.main) {
  const i = process.argv.indexOf("--out");
  const out = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]!) : DEFAULT_OUT;
  const r = await buildHighlighter(out);
  console.log(`build-highlighter: ${r.out} (${(r.bytes / 1024 / 1024).toFixed(2)} MB, ${r.ms} ms)`);
}
