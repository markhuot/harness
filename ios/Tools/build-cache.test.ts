import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { build as esbuild } from "esbuild";
import { join, resolve } from "node:path";
import { bundleInputs, planXcodegen, xcfilelist, xcodegenHash } from "./build-cache";

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "build-cache-test-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (path: string, text = "x") => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

test("xcodegen runs for a missing project or record, and for a changed hash only", () => {
  expect(planXcodegen({ projectExists: false, lastHash: "a", hash: "a" }).run).toBe(true);
  expect(planXcodegen({ projectExists: true, lastHash: null, hash: "a" }).run).toBe(true);
  expect(planXcodegen({ projectExists: true, lastHash: "a", hash: "b" }).run).toBe(true);
  expect(planXcodegen({ projectExists: true, lastHash: "a", hash: "a" })).toEqual({ run: false });
});

test("the xcodegen hash follows project.yml and the globbed file names, not their contents", () => {
  const ios = join(dir, "ios");
  write(join(ios, "project.yml"), "name: Harness");
  write(join(ios, "Harness/App.swift"), "one");
  const base = xcodegenHash(ios);
  write(join(ios, "Harness/App.swift"), "two");
  expect(xcodegenHash(ios)).toBe(base);
  write(join(ios, "Harness/Views/New.swift"));
  const added = xcodegenHash(ios);
  expect(added).not.toBe(base);
  write(join(ios, "project.yml"), "name: Other");
  expect(xcodegenHash(ios)).not.toBe(added);
});

test("bundle inputs list sources and the lockfile, skip tests, and are relative to ios/", () => {
  const ios = join(dir, "ios");
  write(join(dir, "bun.lock"));
  write(join(dir, "package.json"));
  write(join(ios, "Tools/highlighter/entry.ts"));
  write(join(ios, "Tools/highlighter/highlight.test.ts"));
  write(join(ios, "Tools/build-highlighter.ts"));
  write(join(dir, "editor/src/index.ts"));
  write(join(dir, "editor/src/editor.test.ts"));
  write(join(dir, "editor/scripts/build.ts"));
  write(join(dir, "editor/package.json"));
  write(join(dir, "shared/src/diff.ts"));
  write(join(dir, "shared/src/themes/index.ts"));
  write(join(dir, "shared/src/diff.test.ts"));
  write(join(dir, "shared/package.json"));
  const inputs = bundleInputs(ios);
  expect(inputs.highlighter).toEqual(["../bun.lock", "../package.json", "../shared/src/diff.ts", "../shared/src/themes/index.ts", "../shared/package.json", "Tools/highlighter/entry.ts", "Tools/build-highlighter.ts"]);
  expect(inputs.editor).toEqual(["../bun.lock", "../package.json", "../shared/src/diff.ts", "../shared/src/themes/index.ts", "../shared/package.json", "../editor/src/index.ts", "../editor/scripts/build.ts", "../editor/package.json"]);
  expect(xcfilelist(["a", "b"])).toBe("$(SRCROOT)/a\n$(SRCROOT)/b\n");
});

// The real bundles: every repo file the bundler pulls in must be in the phase's input list, or Xcode
// skips the phase and ships a stale highlighter.js / editor.js.
test("the bundle input lists cover every repo file the bundlers import", async () => {
  const ios = join(import.meta.dir, "..");
  const root = join(ios, "..");
  const inputs = bundleInputs(ios);
  const listed = (list: string[]) => new Set(list.map((f) => resolve(ios, f)));
  const bundles = [
    { name: "highlighter", entry: join(ios, "Tools/highlighter/entry.ts"), list: listed(inputs.highlighter) },
    { name: "editor", entry: join(root, "editor/src/index.ts"), list: listed(inputs.editor) },
  ];
  for (const b of bundles) {
    const r = await esbuild({ entryPoints: [b.entry], bundle: true, write: false, metafile: true, platform: "browser", logLevel: "silent", absWorkingDir: root });
    const metafile = r.metafile;
    const missing = Object.keys(metafile.inputs)
      .map((f) => resolve(root, f))
      .filter((f) => f.startsWith(root + "/") && !f.includes("/node_modules/") && !b.list.has(f));
    expect(missing, `${b.name} imports files its bundle phase doesn't list`).toEqual([]);
  }
});
