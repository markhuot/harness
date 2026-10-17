import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../builders/tmp";
import { generate, type Json } from "./cases";
import { findGaps } from "./completeness";
import { TYPE_EXEMPTIONS, VALUE_EXEMPTIONS } from "./exemptions";

const PROTOCOL = join(import.meta.dir, "../../shared/src/protocol.ts");
const source = readFileSync(PROTOCOL, "utf8");
const exempt = { types: Object.keys(TYPE_EXEMPTIONS), values: Object.keys(VALUE_EXEMPTIONS) };

function registered(text: string, skip = TYPE_EXEMPTIONS) {
  const file = join(tempDir(), "protocol.ts");
  writeFileSync(file, text);
  const generated = generate(file, skip);
  return { generated, registered: { types: Object.keys(generated.types), consts: Object.keys(generated.consts) } };
}

describe("every export of protocol.ts is covered", () => {
  test("each exported wire type and list has fixture cases or an exemption, and no exemption is stale", () => {
    const { registered: r } = registered(source);
    expect(findGaps(source, r, exempt)).toEqual([]);
  });

  test("a new exported type with no fixture is reported", () => {
    const { registered: r } = registered(source);
    expect(findGaps(`${source}\nexport interface BrandNew { id: string }\n`, r, exempt)).toEqual([
      "type BrandNew is exported but has no fixture case and no exemption",
    ]);
  });

  test("a new exported list with no fixture is reported", () => {
    const { registered: r } = registered(source);
    expect(findGaps(`${source}\nexport const NEW_KINDS = ["a"] as const;\n`, r, exempt)).toEqual([
      "NEW_KINDS is exported but has no fixture and no exemption",
    ]);
  });

  test("a fixture for a type that was removed or renamed is reported", () => {
    const { registered: r } = registered(source);
    const without = source.replace("export interface SpecDiff", "interface SpecDiff");
    expect(findGaps(without, r, exempt)).toEqual(["fixture for SpecDiff, which protocol.ts no longer exports as a type"]);
  });

  test("an exemption for something no longer exported is reported", () => {
    const { registered: r } = registered(source);
    expect(findGaps(source, r, { ...exempt, values: [...exempt.values, "GONE"] })).toEqual(["stale exemption: GONE is no longer exported"]);
  });

  test("an exemption for a type that has fixtures is reported", () => {
    const text = "export interface A { id: string }";
    expect(findGaps(text, { types: ["A"], consts: [] }, { types: ["A"], values: [] })).toEqual(["stale exemption: type A has fixtures now"]);
  });
});

describe("the generator", () => {
  const cases = (text: string, name: string) => registered(text).generated.types[name]!.map((c) => c.json);

  test("max sets every optional field, min none, and null clears every nullable one", () => {
    const json = cases(`export interface T { id: string; note?: string; owner: string | null; patch?: string | null }`, "T");
    expect(json).toContainEqual({ id: "id-sample", note: "note-sample", owner: "owner-sample", patch: "patch-sample" });
    expect(json).toContainEqual({ id: "id-sample", owner: null });
    expect(json).toContainEqual({ id: "id-sample", note: "note-sample", owner: null, patch: null });
  });

  test("every member of a literal union and every variant of a tagged union gets a case", () => {
    const literals = cases(`export type Mode = "a" | "b" | "c"`, "Mode");
    expect(literals).toEqual(["a", "b", "c"]);
    const events = cases(`export type Ev = { kind: "x"; n: number } | { kind: "y"; s: string } | { kind: "z" }`, "Ev");
    expect(events.map((e) => (e as { kind: string }).kind).sort()).toEqual(["x", "y", "z"]);
  });

  test("a literal union nested in an object is covered across cases", () => {
    const json = cases(`export interface Row { state: "open" | "shut" | "ajar" }`, "Row");
    expect(json.map((j) => (j as { state: string }).state).sort()).toEqual(["ajar", "open", "shut"]);
  });

  test("a field of a mapped optional type is sampled", () => {
    const json = cases(`export type K = "p" | "q"; export interface M { by: Partial<Record<K, number>> }`, "M");
    expect(json).toContainEqual({ by: { p: 3, q: 3 } });
  });

  test("recursive types end", () => {
    const json = cases(`export interface Node { name: string; kids?: Node[] }`, "Node");
    const depth = (n: Json): number => (typeof n === "object" && n && "kids" in n ? 1 + Math.max(0, ...(n.kids as Json[]).map(depth)) : 0);
    expect(Math.max(...json.map(depth))).toBeGreaterThan(1);
    expect(Math.max(...json.map(depth))).toBeLessThan(20);
  });

  test("an `as const` string list becomes a const fixture, other constants don't", () => {
    const { generated } = registered(`export const KINDS = ["a", "b"] as const; export const LIMIT = 5;`);
    expect(generated.consts).toEqual({ KINDS: ["a", "b"] });
  });
});
