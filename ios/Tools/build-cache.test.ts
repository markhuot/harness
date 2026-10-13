import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const inputs = bundleInputs(ios);
  expect(inputs.highlighter).toEqual(["../bun.lock", "../package.json", "Tools/highlighter/entry.ts", "Tools/build-highlighter.ts"]);
  expect(inputs.editor).toEqual(["../bun.lock", "../package.json", "../editor/src/index.ts", "../editor/scripts/build.ts", "../editor/package.json"]);
  expect(xcfilelist(["a", "b"])).toBe("$(SRCROOT)/a\n$(SRCROOT)/b\n");
});
