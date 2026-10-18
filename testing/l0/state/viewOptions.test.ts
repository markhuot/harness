import { describe, expect, test } from "bun:test";
import { hasRenderedView, parseWrapPrefs, serializeWrapPrefs, viewMenu, withWrap, wrapKey } from "@harness/shared";
import fixtures from "../../../shared/src/viewOptions.fixtures.json";

describe("wrap key", () => {
  test.each(fixtures.keys as [string, string][])("%s keys on %s", (path, key) => expect(wrapKey(path)).toBe(key));
});

describe("rendered view", () => {
  test.each(fixtures.rendered as [string, boolean][])("%s: %p", (path, yes) => expect(hasRenderedView(path)).toBe(yes));
});

describe("wrap prefs", () => {
  test("a wrapped type is stored and an unwrapped one is dropped", () => {
    const on = withWrap({}, ".html", true);
    expect(parseWrapPrefs(serializeWrapPrefs(on))).toEqual({ ".html": true });
    expect(withWrap(on, ".html", false)).toEqual({});
    expect(withWrap(on, ".ts", true)).toEqual({ ".html": true, ".ts": true });
  });
  test.each([null, "", "nope", "[1]", "null", '"x"'])("%p reads as no settings", (raw) => expect(parseWrapPrefs(raw)).toEqual({}));
  test("non-boolean entries are dropped", () => expect(parseWrapPrefs('{".a":true,".b":"yes",".c":1}')).toEqual({ ".a": true }));
});

describe("view menu", () => {
  const file = (path: string, rendered = false) => viewMenu({ spec: false, path, rendered, showChanges: false, canShowChanges: false });
  const spec = (o: { rendered?: boolean; showChanges?: boolean; canShowChanges?: boolean }) => viewMenu({ spec: true, rendered: false, showChanges: false, canShowChanges: true, ...o });

  test("only markdown files offer a view", () => {
    expect(file("a.md").view).toBe(true);
    expect(file("a.ts").view).toBe(false);
  });
  test("wrap is for source only", () => {
    expect(file("a.md").wrapEnabled).toBe(true);
    expect(file("a.md", true).wrapEnabled).toBe(false);
    expect(file("a.ts", true).wrapEnabled).toBe(true); // a stale rendered flag on a type without a view
  });
  test("a file never offers Show changes", () => expect(file("a.md").showChanges).toBe(false));
  test("the spec offers Show changes only with a revision to compare", () => {
    expect(spec({}).showChanges).toBe(true);
    expect(spec({ canShowChanges: false }).showChanges).toBe(false);
  });
  test("Show changes forces rendered and disables Source and wrap", () => {
    expect(spec({ showChanges: true })).toMatchObject({ rendered: true, sourceEnabled: false, wrapEnabled: false });
    expect(spec({ showChanges: true, canShowChanges: false })).toMatchObject({ rendered: false, sourceEnabled: true });
  });
  test("spec source wraps", () => expect(spec({ rendered: false })).toMatchObject({ rendered: false, wrapEnabled: true }));
});
