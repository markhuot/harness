// Pure extractors for the migration report (scripts/report.ts): each takes a file's source and returns
// the test cases or checks it declares. Static, so the report needs no simulator, Chrome or Swift build.
// Names generated at runtime (loops, helpers) show up as their template, e.g. `${tab} opens at the bottom`.

export type Row = {
  kind: "bun" | "swift" | "snapshot" | "app-check";
  /** Repo-relative file. */
  file: string;
  /** Enclosing suite or check function, "" when none. */
  group: string;
  /** The test or check's own name: what it checks. */
  name: string;
  /** For a test that moved: the new-suite file it lives in now (set by the report from PORTED). */
  ref?: string;
  /** For a test that was dropped on purpose: why. The old file is gone; the row is listed so the loss stays visible. */
  lossReason?: string;
};

const QUOTED = /^(["'`])((?:\\.|(?!\1).)*)\1/;

/** The first string-literal argument starting at `rest`, or null. */
function literal(rest: string): string | null {
  const m = QUOTED.exec(rest.trimStart());
  return m ? m[2]! : null;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

/** `test("x")`, `it("x")`, `test.each(...)("x")` under `describe("y")` blocks, in bun:test files. */
export function extractBunTests(file: string, src: string): Row[] {
  const rows: Row[] = [];
  const lines = src.split("\n");
  const stack: { indent: number; name: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)(describe|test|it)(\.(?!each)\w+)?(\.each\(.*\))?\(\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const rest = m[5]!;
    let name = literal(rest);
    if (name === null && m[4]) {
      // `test.each([..])("name"` where the table ends the line: the name is on the next line or after `)(`.
      const after = /\)\(\s*(["'`].*)$/.exec(line);
      name = after ? literal(after[1]!) : null;
    }
    if (name === null && rest.trim() === "") name = literal(lines[i + 1] ?? "");
    if (name === null) continue;
    if (m[2] === "describe") stack.push({ indent, name });
    else rows.push({ kind: "bun", file, group: stack.map((s) => s.name).join(" › "), name });
  }
  return rows;
}

/** Swift Testing `@Test func name()` and `@Test("display name")`, with the enclosing `@Suite` struct. */
export function extractSwiftTests(file: string, src: string): Row[] {
  const rows: Row[] = [];
  let suite = "";
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const s = /^\s*(?:@Suite(?:\([^)]*\))?\s+)?(?:(?:public|final|private)\s+)*(?:struct|class|enum)\s+(\w+)/.exec(line);
    if (s) suite = s[1]!;
    if (!/^\s*@Test\b/.test(line)) continue;
    const display = /@Test\(\s*"((?:\\.|[^"])*)"/.exec(line)?.[1];
    // The func may be on this line or a later one (after other attributes).
    let fn: string | undefined;
    for (let j = i; j < Math.min(i + 80, lines.length); j++) {
      if (j > i && /^\s*@Test\b/.test(lines[j]!)) break; // a parameter table can span many lines
      fn = /\bfunc\s+(\w+)/.exec(lines[j]!)?.[1];
      if (fn) break;
    }
    rows.push({ kind: "swift", file, group: suite, name: display ?? fn ?? "(unnamed)" });
  }
  return rows;
}

/** XCTest `func testX()` in the iPhone snapshot target. */
export function extractSnapshotTests(file: string, src: string): Row[] {
  const rows: Row[] = [];
  let cls = "";
  for (const line of src.split("\n")) {
    const c = /^\s*(?:final\s+)?(?:class|extension)\s+(\w+)/.exec(line);
    if (c) cls = c[1]!;
    const t = /^\s*func\s+(test\w*)\(/.exec(line);
    if (t) rows.push({ kind: "snapshot", file, group: cls, name: t[1]! });
  }
  return rows;
}

/** `const NAME = "text"` constants, so `check(NAME, ...)` can show its text. */
function constants(src: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of src.matchAll(/^\s*const\s+([A-Z_]\w*)\s*=\s*(["'`])((?:\\.|(?!\2).)*)\2/gm)) map.set(m[1]!, m[3]!);
  return map;
}

function checkName(arg: string, consts: Map<string, string>): string {
  const lit = literal(arg);
  if (lit !== null) return lit;
  const id = /^(\w+)/.exec(arg.trim())?.[1];
  if (id && consts.has(id)) return consts.get(id)!;
  return `<${arg.trim().replace(/[,)].*$/, "") || "dynamic"}>`;
}

/** The Mac scripts' `check("name", ok, detail)` calls (the `checker()` helper in app/scripts/lib/drive.ts). */
export function extractAppChecks(file: string, src: string): Row[] {
  const rows: Row[] = [];
  const consts = constants(src);
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:await\s+)?(?:[\w.]+\.)?check\(\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    if (/^\s*(?:async\s+)?function\b|=>\s*\{?\s*$/.test(lines[i]!) && !/check\(\s*["'`]/.test(lines[i]!)) continue;
    const arg = m[1]!.trim() === "" ? (lines[i + 1] ?? "").trim() : m[1]!;
    rows.push({ kind: "app-check", file, group: "", name: checkName(arg, consts) });
  }
  return rows;
}
