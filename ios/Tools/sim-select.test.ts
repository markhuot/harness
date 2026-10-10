import { describe, expect, test } from "bun:test";
import { parsePrepare, plan, resolveShot, type Entry } from "./sim-select";

const entries: Entry[] = [
  { name: "ticket-spec", kind: "screen", needs: ["hello"], visit: true },
  { name: "ticket-headings", kind: "screen", needs: ["headings"] },
  { name: "browser", kind: "screen", needs: ["browse"] },
  { name: "composer", kind: "chain", needs: ["blocked"] },
  { name: "approve", kind: "chain", needs: ["agents", "hello"] },
  { name: "sheet-checks", kind: "chain", needs: ["conductor"], optIn: true },
];
const run = (o: Parameters<typeof plan>[1]) => {
  const p = plan(entries, o);
  return { steps: p.steps.map((s) => `${s.action}:${s.entry.name}`), seeds: [...p.seeds].sort() };
};

describe("plan", () => {
  test("validation runs the chains and only visits the screens flagged, shooting nothing", () => {
    const r = run({});
    expect(r.steps).toEqual(["visit:ticket-spec", "run:composer", "run:approve"]);
    expect(r.steps.some((s) => s.startsWith("shoot"))).toBe(false);
  });
  test("validation seeds only what its selection needs: no browse ticket, no headings", () => {
    expect(run({}).seeds).toEqual(["agents", "blocked", "hello"]);
  });
  test("an opt-in chain joins validation only when its flag names it", () => {
    expect(run({ extra: ["sheet-checks"] }).steps).toContain("run:sheet-checks");
    expect(run({}).steps).not.toContain("run:sheet-checks");
  });
  test("--screens shoots the whole catalog and runs no chain", () => {
    const r = run({ screens: true });
    expect(r.steps).toEqual(["shoot:ticket-spec", "shoot:ticket-headings", "shoot:browser"]);
    expect(r.seeds).toEqual(["browse", "headings", "hello"]);
  });
  test("--only picks screens and chains by name, and seeds just those", () => {
    const r = run({ only: ["ticket-headings", "composer"] });
    expect(r.steps).toEqual(["shoot:ticket-headings", "run:composer"]);
    expect(r.seeds).toEqual(["blocked", "headings"]);
  });
  test("--only can name an opt-in chain", () => {
    expect(run({ only: ["sheet-checks"] }).steps).toEqual(["run:sheet-checks"]);
  });
  test("--only with a name nothing has fails, listing the known ones", () => {
    expect(() => plan(entries, { only: ["nope"] })).toThrow(/unknown nope; known: ticket-spec/);
  });
});

describe("resolveShot", () => {
  const keys = { hello: "GREET-1", headings: "SITE-14" } as Record<string, string>;
  test("fills each {name} with the seeded ticket's key and reports the seeds needed", () => {
    const r = resolveShot("harness://ticket/{headings}?tab=spec", (n) => keys[n]!);
    expect(r.url).toBe("harness://ticket/SITE-14?tab=spec");
    expect(r.needs).toEqual(["headings"]);
  });
  test("a link with no placeholders needs no seeds", () => {
    expect(resolveShot("harness://settings", () => "x")).toEqual({ url: "harness://settings", needs: [] });
  });
  test("an unknown name fails, so a typo doesn't open a dead link", () => {
    expect(() => resolveShot("harness://ticket/{nope}", () => "x")).toThrow(/no seeded ticket named \{nope\}/);
  });
});

describe("parsePrepare", () => {
  test("splits tap and scroll steps on ;, keeping commas and colons inside a label", () => {
    expect(parsePrepare("scroll:Models, ;tap:Base: branch")).toEqual([
      { op: "scroll", label: "Models, " },
      { op: "tap", label: "Base: branch" },
    ]);
  });
  test("an unknown step fails, and no steps is none", () => {
    expect(() => parsePrepare("swipe:up")).toThrow(/isn't tap:<label> or scroll:<label>/);
    expect(parsePrepare(undefined)).toEqual([]);
  });
});
