import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inside, safeJoin } from "../../service/src/safe-path";
import { tempDir } from "../builders/tmp";

test("joins a relative path under the root, existing or not", () => {
  const root = tempDir();
  writeFileSync(join(root, "a.txt"), "x");
  expect(safeJoin(root, "a.txt")).toBe(join(root, "a.txt"));
  expect(safeJoin(root, "missing/b.txt")).toBe(join(root, "missing", "b.txt"));
});

test("refuses .., NUL bytes and a symlink that leaves the root", () => {
  const root = tempDir();
  const outside = tempDir();
  writeFileSync(join(outside, "secret"), "s");
  symlinkSync(outside, join(root, "link"));
  expect(safeJoin(root, "../x")).toBeNull();
  expect(safeJoin(root, "a/../../x")).toBeNull();
  expect(safeJoin(root, "a\0b")).toBeNull();
  expect(safeJoin(root, "link/secret")).toBeNull();
});

test("an absolute-looking path is taken relative to the root, not as an escape", () => {
  const root = tempDir();
  expect(safeJoin(root, "/etc/passwd")).toBe(join(root, "etc", "passwd"));
});

test("a symlink that stays inside the root is allowed", () => {
  const root = tempDir();
  mkdirSync(join(root, "real"));
  writeFileSync(join(root, "real", "f"), "x");
  symlinkSync(join(root, "real"), join(root, "alias"));
  expect(safeJoin(root, "alias/f")).toBe(join(root, "alias", "f"));
});

test("inside is a path-segment check, not a string prefix", () => {
  expect(inside("/a/b", "/a/b")).toBe(true);
  expect(inside("/a/b/c", "/a/b")).toBe(true);
  expect(inside("/a/bc", "/a/b")).toBe(false);
  expect(inside("/a/b/c", "/a/b/")).toBe(true);
});
