import { expect, test } from "bun:test";
import { join } from "node:path";
import { coverageProblems } from "./coverage-guard";
import { EXCLUSIONS, type Exclusion } from "./exclusions";
import { tempDir } from "../builders/tmp";
import { writeFile } from "./files";

const ROOT = join(import.meta.dir, "..", "..");

test("every service module is tested by a file under testing/service or is listed in exclusions.ts with a reason and a layer", () => {
  expect(coverageProblems(ROOT, import.meta.dir, EXCLUSIONS)).toEqual([]);
});

/** A tiny repo: service/src/{tested,untested,viaOwner,viaOwned}.ts and a test that imports some of them. */
function fixture(testImports: string[]) {
  const root = tempDir();
  for (const m of ["tested", "untested", "viaOwner", "viaOwned"]) writeFile(root, `service/src/${m}.ts`, m === "viaOwner" ? 'export * from "./viaOwned";' : "export const x = 1;");
  writeFile(root, "service/src/tested.test.ts", "// an old colocated test never counts");
  writeFile(root, "service/src/testing/fakes.ts", "export {}");
  writeFile(root, "testing/service/a.test.ts", testImports.map((m) => `import "../../service/src/${m}";`).join("\n"));
  return { root, tests: join(root, "testing/service") };
}

const entry = (file: string, over: Partial<Exclusion> = {}): Exclusion => ({ file: `service/src/${file}.ts`, reason: "because", layer: "L9", ...over });

test("a module no test imports and no exclusion names is reported", () => {
  const f = fixture(["tested", "viaOwner"]);
  expect(coverageProblems(f.root, f.tests, [entry("viaOwned", { via: "service/src/viaOwner.ts" })])).toEqual(["service/src/untested.ts: no test imports it and it isn't in exclusions.ts"]);
});

test("a listed module is fine, and an old colocated test doesn't count as covering its module", () => {
  const f = fixture(["viaOwner"]);
  expect(coverageProblems(f.root, f.tests, [entry("untested"), entry("viaOwned", { via: "service/src/viaOwner.ts" })])).toEqual(["service/src/tested.ts: no test imports it and it isn't in exclusions.ts"]);
  expect(coverageProblems(f.root, f.tests, [entry("untested"), entry("tested"), entry("viaOwned", { via: "service/src/viaOwner.ts" })])).toEqual([]);
});

test("a listing goes stale when the module is deleted or a test starts importing it", () => {
  const f = fixture(["tested", "viaOwner"]);
  const problems = coverageProblems(f.root, f.tests, [entry("untested"), entry("tested"), entry("gone"), entry("viaOwned", { via: "service/src/viaOwner.ts" })]);
  expect(problems).toEqual([
    "service/src/tested.ts: listed in exclusions.ts but a test imports it now; remove the listing",
    "service/src/gone.ts: listed in exclusions.ts but it isn't a service module (deleted or renamed?)",
  ]);
});

test("a listing needs a reason and a layer, and can't appear twice", () => {
  const f = fixture(["tested", "viaOwner"]);
  const problems = coverageProblems(f.root, f.tests, [entry("untested", { reason: " " }), entry("untested", { layer: "" }), entry("viaOwned", { via: "service/src/viaOwner.ts" })]);
  expect(problems).toContain("service/src/untested.ts: an exclusion needs a reason and the layer that owns it");
  expect(problems).toContain("service/src/untested.ts: listed twice in exclusions.ts");
});

test("a `via` listing is checked: the owner must be imported by a test and must import the module", () => {
  const notTested = fixture(["tested"]);
  expect(coverageProblems(notTested.root, notTested.tests, [entry("untested"), entry("viaOwner"), entry("viaOwned", { via: "service/src/viaOwner.ts" })])).toContain("service/src/viaOwned.ts: via service/src/viaOwner.ts, which no test imports");
  const wrongOwner = fixture(["tested", "viaOwner"]);
  expect(coverageProblems(wrongOwner.root, wrongOwner.tests, [entry("untested"), entry("viaOwned", { via: "service/src/tested.ts" })])).toContain("service/src/viaOwned.ts: via service/src/tested.ts, which doesn't import it");
});

test("a folder's index.ts counts as imported when a test imports the folder", () => {
  const root = tempDir();
  writeFile(root, "service/src/store/index.ts", "export {}");
  writeFile(root, "testing/service/a.test.ts", 'import "../../service/src/store";');
  expect(coverageProblems(root, join(root, "testing/service"), [])).toEqual([]);
});
