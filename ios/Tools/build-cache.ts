// What ios/Tools/build.ts reuses between builds, as decisions that touch no tool: whether XcodeGen
// has to run again, and which files the two bundle build phases read. build.ts does the copying and running (build-cache.test.ts
// covers these).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export type GeneratePlan = { run: true; reason: string } | { run: false };

/** XcodeGen has to run when there's no project yet, or what it reads differs from the last run's. */
export function planXcodegen(o: { projectExists: boolean; lastHash: string | null; hash: string }): GeneratePlan {
  if (!o.projectExists) return { run: true, reason: "no Harness.xcodeproj yet" };
  if (o.lastHash === null) return { run: true, reason: "no record of the last generation" };
  if (o.lastHash !== o.hash) return { run: true, reason: "project.yml or the source files changed" };
  return { run: false };
}

/** The app's source folders; XcodeGen globs them, so adding or removing a file changes the project. */
const GLOBBED = ["Harness", "Widgets/Sources", "Widgets/iOS", "Widgets/macOS", "HarnessSnapshotTests"];
/** Folders XcodeGen doesn't glob into a target (the snapshot tests' reference images). */
const NOT_GLOBBED = /(^|\/)References(\/|$)/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (NOT_GLOBBED.test(name)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/**
 * A hash of everything XcodeGen reads: project.yml's bytes, and the names (not contents) of the files
 * it globs into targets. Edits to a Swift file don't change the project; a new file does.
 */
export function xcodegenHash(ios: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(join(ios, "project.yml")));
  for (const dir of GLOBBED) for (const f of walk(join(ios, dir))) h.update(`\0${relative(ios, f)}`);
  return h.digest("hex");
}

/** The files each bundle build phase reads, as paths relative to ios/ (the phases run bun on them). */
export function bundleInputs(ios: string): { highlighter: string[]; editor: string[] } {
  const root = resolve(ios, "..");
  const sources = (dir: string) =>
    walk(join(root, dir)).filter((f) => /\.(tsx?|[mc]?js|json|css)$/.test(f) && !/\.test\.tsx?$/.test(f)).map((f) => relative(ios, f));
  // bun.lock pins the Shiki and esbuild versions, so a dependency update reruns the phases.
  const shared = [relative(ios, join(root, "bun.lock")), relative(ios, join(root, "package.json"))].filter((f) => existsSync(join(ios, f)));
  // Both bundles import @harness/shared (themes, diff); package.json's exports map resolves it.
  const harnessShared = [...sources("shared/src"), "../shared/package.json"];
  return {
    highlighter: [...shared, ...harnessShared, ...sources("ios/Tools/highlighter"), "Tools/build-highlighter.ts"],
    editor: [...shared, ...harnessShared, ...sources("editor/src"), "../editor/scripts/build.ts", "../editor/package.json"],
  };
}

/** An .xcfilelist body: one `$(SRCROOT)`-relative path per line. */
export function xcfilelist(files: readonly string[]): string {
  return files.map((f) => `$(SRCROOT)/${f}`).join("\n") + "\n";
}
