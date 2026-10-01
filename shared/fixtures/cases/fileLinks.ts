// File links in chat messages (shared/src/fileLinks.ts) for HarnessKit's FileLinks.swift.
import { type FileLink, formatFileLink, lineRangeLabel, parseFileLink } from "../../src/fileLinks";
import { cases } from "../case";

export const parseFileLinkCases = cases(parseFileLink, {
  // harness://file with no range, one line, and a range
  "no range": "harness://file/src/app.ts",
  "one line": "harness://file/src/app.ts#L102",
  range: "harness://file/src/app.ts#L102-L115",
  "range without second L": "harness://file/src/app.ts#L102-115",
  "upper-case prefix": "HARNESS://FILE/src/app.ts",
  "mixed-case prefix": "Harness://File/src/app.ts#L3",
  // ranges
  "reversed range swaps": "harness://file/a.ts#L20-L10",
  "one-line range collapses": "harness://file/a.ts#L7-L7",
  "junk anchor L": "harness://file/a.ts#L",
  "junk anchor Lx": "harness://file/a.ts#Lx",
  "junk anchor colon": "harness://file/a.ts#L10:20",
  "junk anchor trailing dash": "harness://file/a.ts#L10-",
  "junk anchor Lx end": "harness://file/a.ts#L10-Lx",
  "line zero": "harness://file/a.ts#L0",
  "section anchor": "harness://file/a.ts#section",
  "lower-case l": "harness://file/a.ts#l5",
  "reversed to zero start drops range": "harness://file/a.ts#L5-L0",
  "zero start drops range": "harness://file/a.ts#L0-L3",
  "leading zeros": "harness://file/a.ts#L007-L010",
  "non-ASCII digits": "harness://file/a.ts#L١٢",
  "second hash stays in the anchor": "harness://file/a.ts#L1#L2",
  // decoding
  "percent-encoded space": "harness://file/docs/my%20notes.md#L3",
  "percent-encoded UTF-8": "docs/caf%C3%A9.md",
  "malformed escape": "harness://file/bad%E0%A4.ts",
  "lone percent": "harness://file/100%.ts",
  "NUL byte": "harness://file/a%00.ts",
  "encoded slash splits": "harness://file/a%2Fb.ts",
  "plus stays in the path": "harness://file/a+b.ts",
  "raw unicode path": "harness://file/über/naïve.ts",
  "combining mark after slash": "src/\u0301a.ts",
  // ?ticket and ?project
  "ticket before range": "harness://file/src/a.ts?ticket=HARNESS-12#L4",
  "project and unknown param": "harness://file/src/a.ts?project=p_1&other=x",
  "empty ticket ignored": "harness://file/src/a.ts?ticket=",
  "ticket without equals": "harness://file/src/a.ts?ticket",
  "plus in value is a space": "harness://file/src/a.ts?project=p+1",
  "encoded value": "harness://file/src/a.ts?project=p%26q",
  "bad escape in value is skipped": "harness://file/src/a.ts?project=%E0%A4&ticket=K-1",
  "later duplicate wins": "harness://file/src/a.ts?ticket=A-1&ticket=B-2",
  "key is not decoded": "harness://file/src/a.ts?%74icket=A-1",
  "empty query": "harness://file/src/a.ts?",
  "empty pairs": "harness://file/src/a.ts?&&ticket=A-1&",
  "hash before question mark": "harness://file/src/a.ts#L3?ticket=A-1",
  // normalization
  "leading ./": "./src/x.ts",
  "inner .. and .": "harness://file/src/../lib/./y.ts",
  "doubled slashes collapse": "harness://file/src//lib///y.ts",
  ".. escaping the root": "harness://file/../secret",
  "relative .. escaping the root": "src/../../etc/passwd",
  "encoded .. escaping the root": "harness://file/%2E%2E/secret",
  "absolute .. escaping the root": "/../etc",
  "empty harness path": "harness://file/",
  "only ./": "./",
  "empty string": "",
  "trailing slash dropped": "src/dir/",
  "triple dot is a name": "harness://file/.../a",
  // scheme-less relative and absolute paths
  "relative with range": "src/app.ts#L10-L20",
  absolute: "/Users/me/repo/a.ts#L5",
  "absolute via harness prefix": "harness://file//Users/me/a.ts",
  // not file links
  "bare anchor": "#foo",
  mailto: "mailto:a@b.c",
  https: "https://x.y/a.ts",
  javascript: "javascript:alert(1)",
  data: "data:text/html,x",
  "protocol-relative": "//host/a.ts",
  "other harness route": "harness://ticket/HARNESS-1",
  "file scheme": "file:///etc/passwd",
  "digit-led scheme is a path": "1abc:foo",
  "colon later in the path": "src/a:b.ts",
  "windows drive is a scheme": "C:/x.ts",
});

type FormatInput = Omit<FileLink, "absolute"> & { absolute?: boolean };

export const formatFileLinkCases = cases(formatFileLink, {
  range: { path: "src/app.ts", startLine: 102, endLine: 115 },
  "reversed range": { path: "src/app.ts", startLine: 115, endLine: 102 },
  "one-line range": { path: "src/app.ts", startLine: 9, endLine: 9 },
  "no range": { path: "src/app.ts" },
  "encoded segments and params": { path: "my dir/a#b?.ts", ticketKey: "HARNESS-12", projectId: "p 1" },
  absolute: { path: "/Users/me/x.ts", startLine: 1 },
  "empty segments dropped": { path: "/a//b/", ticketKey: "" },
  "project only": { path: "a.ts", projectId: "p&q" },
  "line zero is no range": { path: "a.ts", startLine: 0, endLine: 5 },
  "end without start": { path: "a.ts", endLine: 5 },
  "end zero": { path: "a.ts", startLine: 5, endLine: 0 },
  "negative start": { path: "a.ts", startLine: -3 },
  unicode: { path: "über/naïve.ts" },
} satisfies Record<string, FormatInput>);

// format → parse round trips (the test in fileLinks.test.ts).
export const roundTripCases = cases((l: FormatInput) => parseFileLink(formatFileLink(l)), {
  plain: { path: "src/app.ts", absolute: false },
  everything: { path: "my dir/a#b?.ts", startLine: 3, endLine: 8, ticketKey: "K-1", projectId: "p&q", absolute: false },
  absolute: { path: "/Users/me/x.ts", startLine: 1, absolute: true },
  "plus in project": { path: "a.ts", projectId: "a+b", absolute: false },
} satisfies Record<string, FormatInput>);

type LabelInput = Pick<FileLink, "path" | "startLine" | "endLine">;

export const lineRangeLabelCases = cases(lineRangeLabel, {
  "no range": { path: "src/app.ts" },
  "one line": { path: "src/app.ts", startLine: 102 },
  range: { path: "src/app.ts", startLine: 102, endLine: 115 },
  "trailing slash": { path: "src/dir/" },
  "only slashes keeps the path": { path: "/" },
  "empty path": { path: "" },
  "end without start": { path: "a.ts", endLine: 4 },
  "line zero": { path: "a.ts", startLine: 0 },
  "end zero": { path: "a.ts", startLine: 3, endLine: 0 },
} satisfies Record<string, LabelInput>);
