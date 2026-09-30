import { expect, test } from "bun:test";
import { formatFileLink, lineRangeLabel, parseFileLink } from "./fileLinks";

test("file links: harness://file paths with no range, one line, and a range", () => {
  expect(parseFileLink("harness://file/src/app.ts")).toEqual({ path: "src/app.ts", absolute: false });
  expect(parseFileLink("harness://file/src/app.ts#L102")).toEqual({ path: "src/app.ts", startLine: 102, absolute: false });
  expect(parseFileLink("harness://file/src/app.ts#L102-L115")).toEqual({ path: "src/app.ts", startLine: 102, endLine: 115, absolute: false });
  expect(parseFileLink("harness://file/src/app.ts#L102-115")).toMatchObject({ startLine: 102, endLine: 115 });
});

test("file links: reversed ranges swap, a one-line range collapses, junk anchors drop the range without failing", () => {
  expect(parseFileLink("harness://file/a.ts#L20-L10")).toMatchObject({ startLine: 10, endLine: 20 });
  expect(parseFileLink("harness://file/a.ts#L7-L7")).toEqual({ path: "a.ts", startLine: 7, absolute: false });
  for (const junk of ["#L", "#Lx", "#L10:20", "#L10-", "#L10-Lx", "#L0", "#section"]) {
    expect(parseFileLink(`harness://file/a.ts${junk}`)).toEqual({ path: "a.ts", absolute: false });
  }
});

test("file links: percent-encoded segments decode; malformed escapes and NUL bytes are rejected", () => {
  expect(parseFileLink("harness://file/docs/my%20notes.md#L3")?.path).toBe("docs/my notes.md");
  expect(parseFileLink("docs/caf%C3%A9.md")?.path).toBe("docs/café.md");
  expect(parseFileLink("harness://file/bad%E0%A4.ts")).toBeNull();
  expect(parseFileLink("harness://file/a%00.ts")).toBeNull();
});

test("file links: ?ticket and ?project overrides, before the range", () => {
  expect(parseFileLink("harness://file/src/a.ts?ticket=HARNESS-12#L4")).toEqual({ path: "src/a.ts", startLine: 4, ticketKey: "HARNESS-12", absolute: false });
  expect(parseFileLink("harness://file/src/a.ts?project=p_1&other=x")).toEqual({ path: "src/a.ts", projectId: "p_1", absolute: false });
  expect(parseFileLink("harness://file/src/a.ts?ticket=")).toEqual({ path: "src/a.ts", absolute: false });
});

test("file links: ./ and inner .. normalize; .. escaping the root is rejected", () => {
  expect(parseFileLink("./src/x.ts")?.path).toBe("src/x.ts");
  expect(parseFileLink("harness://file/src/../lib/./y.ts")?.path).toBe("lib/y.ts");
  expect(parseFileLink("harness://file/../secret")).toBeNull();
  expect(parseFileLink("src/../../etc/passwd")).toBeNull();
  expect(parseFileLink("harness://file/%2E%2E/secret")).toBeNull();
  expect(parseFileLink("/../etc")).toBeNull();
  expect(parseFileLink("harness://file/")).toBeNull();
  expect(parseFileLink("./")).toBeNull();
});

test("file links: scheme-less relative and absolute paths; other schemes and bare anchors are not file links", () => {
  expect(parseFileLink("src/app.ts#L10-L20")).toEqual({ path: "src/app.ts", startLine: 10, endLine: 20, absolute: false });
  expect(parseFileLink("/Users/me/repo/a.ts#L5")).toEqual({ path: "/Users/me/repo/a.ts", startLine: 5, absolute: true });
  for (const url of ["#foo", "mailto:a@b.c", "https://x.y/a.ts", "javascript:alert(1)", "data:text/html,x", "//host/a.ts", "harness://ticket/HARNESS-1", "file:///etc/passwd"]) {
    expect(parseFileLink(url)).toBeNull();
  }
});

test("file links: format produces the canonical URL and round-trips through parse", () => {
  expect(formatFileLink({ path: "src/app.ts", startLine: 102, endLine: 115 })).toBe("harness://file/src/app.ts#L102-L115");
  expect(formatFileLink({ path: "src/app.ts", startLine: 115, endLine: 102 })).toBe("harness://file/src/app.ts#L102-L115");
  expect(formatFileLink({ path: "src/app.ts", startLine: 9, endLine: 9 })).toBe("harness://file/src/app.ts#L9");
  expect(formatFileLink({ path: "my dir/a#b?.ts", ticketKey: "HARNESS-12", projectId: "p 1" })).toBe(
    "harness://file/my%20dir/a%23b%3F.ts?ticket=HARNESS-12&project=p%201",
  );
  const cases = [
    { path: "src/app.ts", absolute: false },
    { path: "my dir/a#b?.ts", startLine: 3, endLine: 8, ticketKey: "K-1", projectId: "p&q", absolute: false },
    { path: "/Users/me/x.ts", startLine: 1, absolute: true },
  ];
  for (const c of cases) expect(parseFileLink(formatFileLink(c))).toEqual(c);
});

test("file links: line range labels", () => {
  expect(lineRangeLabel({ path: "src/app.ts" })).toBe("app.ts");
  expect(lineRangeLabel({ path: "src/app.ts", startLine: 102 })).toBe("app.ts:102");
  expect(lineRangeLabel({ path: "src/app.ts", startLine: 102, endLine: 115 })).toBe("app.ts:102-115");
});
