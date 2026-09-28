import { expect, test } from "bun:test";
import { readSidebarCollapsed, readStyle, saveSidebarCollapsed, saveStyle, SIDEBAR_KEY, STYLE_KEY } from "./prefs";

function memory(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  return { m, get: () => store };
}
const throwing = () => {
  throw new Error("SecurityError: localStorage is not available");
};

test("sidebar collapse round-trips and defaults to expanded", () => {
  const s = memory();
  expect(readSidebarCollapsed(s.get)).toBe(false);
  saveSidebarCollapsed(true, s.get);
  expect(readSidebarCollapsed(s.get)).toBe(true);
  saveSidebarCollapsed(false, s.get);
  expect(readSidebarCollapsed(s.get)).toBe(false);
  expect(s.m.get(SIDEBAR_KEY)).toBe("0");
});

test("unrecognised stored sidebar values mean expanded", () => {
  for (const v of ["true", "yes", "", "collapsed", "01"]) expect(readSidebarCollapsed(memory({ [SIDEBAR_KEY]: v }).get)).toBe(false);
});

test("diff style ignores values that aren't a style", () => {
  expect(readStyle(memory({ [STYLE_KEY]: "split" }).get)).toBe("split");
  expect(readStyle(memory({ [STYLE_KEY]: "Split" }).get)).toBeNull();
  expect(readStyle(memory().get)).toBeNull();
  const s = memory();
  saveStyle("unified", s.get);
  expect(readStyle(s.get)).toBe("unified");
});

test("unavailable storage reads as no preference and writes don't throw", () => {
  expect(readSidebarCollapsed(throwing)).toBe(false);
  expect(readStyle(throwing)).toBeNull();
  expect(() => saveSidebarCollapsed(true, throwing)).not.toThrow();
  expect(() => saveStyle("split", throwing)).not.toThrow();
  const failingSet = { getItem: () => null, setItem: throwing };
  expect(() => saveSidebarCollapsed(true, () => failingSet)).not.toThrow();
});
