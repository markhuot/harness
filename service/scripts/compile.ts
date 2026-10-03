// Compile the service into one executable for Harness.app, so the Mac running it needs no bun or
// checkout (DESIGN.md "Runtime paths"):
//
//   <out>/MacOS/harness-service       bun build --compile of service/src/bin.ts (daemon + CLI)
//   <out>/Resources/plugins/<id>/     each builtin plugin, prebuilt: plugin.json, server.js
//                                     (its server bundled with its dependencies) and its UI
//
// The layout mirrors Harness.app/Contents, where runtime.ts looks for the plugins.
//   bun service/scripts/compile.ts <out>      (app/scripts/package.ts calls compileService)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { describeRelease } from "../src/release";
import { SERVICE_EXECUTABLE } from "../src/runtime";

const repoRoot = resolve(import.meta.dir, "..", "..");

export interface CompiledService {
  executable: string;
  plugins: string[];
}

export async function compileService(out: string): Promise<CompiledService> {
  const executable = join(out, "MacOS", SERVICE_EXECUTABLE);
  mkdirSync(join(out, "MacOS"), { recursive: true });
  const target = `bun-darwin-${process.arch === "arm64" ? "arm64" : "x64"}`;
  // The release /health reports (service/src/release.ts): the executable has no git to ask.
  const release = `HARNESS_RELEASE=${JSON.stringify(describeRelease(repoRoot) ?? "")}`;
  await $`${process.execPath} build --compile --minify-syntax --target=${target} --define ${release} ${join(repoRoot, "service/src/bin.ts")} --outfile ${executable}`.cwd(repoRoot).quiet();

  const pluginsOut = join(out, "Resources", "plugins");
  rmSync(pluginsOut, { recursive: true, force: true });
  const plugins: string[] = [];
  for (const name of readdirSync(join(repoRoot, "plugins")).sort()) {
    const dir = join(repoRoot, "plugins", name);
    const manifestPath = join(dir, "plugin.json");
    if (!existsSync(manifestPath)) continue; // sdk/ and friends aren't plugins
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { id: string; server?: string; ui?: string; build?: string };
    const dest = join(pluginsOut, name);
    mkdirSync(dest, { recursive: true });
    if (manifest.build) await $`${process.execPath} ${join(dir, manifest.build)}`.cwd(dir).quiet();
    if (manifest.ui) {
      if (!existsSync(join(dir, manifest.ui, "index.html"))) throw new Error(`plugin ${manifest.id}: ${manifest.ui} has no index.html`);
      cpSync(join(dir, manifest.ui), join(dest, manifest.ui), { recursive: true });
    }
    if (manifest.server) {
      const built = await Bun.build({ entrypoints: [join(dir, manifest.server)], target: "bun", format: "esm", minify: { syntax: true } });
      if (!built.success) throw new AggregateError(built.logs, `plugin ${manifest.id}: server bundle failed`);
      writeFileSync(join(dest, "server.js"), await built.outputs[0]!.text());
    }
    // Prebuilt: the server is the bundle and there's nothing left to build.
    const { build: _build, ...rest } = manifest;
    writeFileSync(join(dest, "plugin.json"), JSON.stringify({ ...rest, ...(manifest.server ? { server: "server.js" } : {}) }, null, 2) + "\n");
    plugins.push(manifest.id);
  }
  return { executable, plugins };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: bun service/scripts/compile.ts <out dir>");
    process.exit(2);
  }
  const r = await compileService(resolve(out));
  console.log(`compiled → ${r.executable} (plugins: ${r.plugins.join(", ") || "none"})`);
}
