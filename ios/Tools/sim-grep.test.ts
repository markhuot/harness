import { expect, test } from "bun:test";
import { CheckSelector, noMatchMessage, nearbyNames, parseGrep } from "./sim-grep";

test("parseGrep: a plain pattern is a case-insensitive substring, /x/flags a regular expression", () => {
  expect(parseGrep("dirty FILE").test("a Dirty file card's Close asks")).toBe(true);
  expect(parseGrep("a.c").test("abc")).toBe(false); // the dot is not a wildcard in a substring
  expect(parseGrep("a/b").test("x a/b y")).toBe(true); // slashes inside don't make it a regex
  expect(parseGrep("/^a (swipe|drag)/").test("a swipe along the dock")).toBe(true);
  expect(parseGrep("/^a (swipe|drag)/").test("the swipe along")).toBe(false);
  expect(parseGrep("/DOCK/i").test("the dock")).toBe(true);
  expect(parseGrep("/dock/g").test("dock")).toBe(true);
  expect(parseGrep("/dock/g").test("dock")).toBe(true); // a g flag doesn't make the second test miss
  expect(() => parseGrep("/(/")).toThrow("regular expression");
  expect(() => parseGrep("")).toThrow("needs a pattern");
});

test("nearbyNames ranks the names sharing the pattern's words first, and noMatchMessage lists them", () => {
  const names = ["a swipe along the dock", "a dirty file card's Close asks", "Projects closes every docked ticket", "linking lines"];
  expect(nearbyNames("dirty card", names, 2)[0]).toBe("a dirty file card's Close asks");
  expect(nearbyNames("/dock/", names, 3)).toContain("a swipe along the dock");
  const msg = noMatchMessage("zzz", names);
  expect(msg).toContain("matched none of the 4 checks");
  expect(msg).toContain("- a swipe along the dock");
  expect(noMatchMessage("zzz", [])).toContain("no checks ran");
});

const body = (n: string) => n;
function run(grep: string | null, steps: { name: string; needs?: string[]; sequence?: "chained" | "declared" | "new" }[]) {
  const sel = new CheckSelector<string>(grep === null ? null : parseGrep(grep));
  const ran: string[] = [];
  for (const st of steps) {
    if (st.sequence) sel.sequence(st.sequence === "new" ? "chained" : st.sequence);
    const d = sel.visit(st.name, st.needs, body(st.name));
    for (const s of d.setup) ran.push(`setup:${s.name}`);
    if (d.run) ran.push(st.name);
  }
  return { ran, sel };
}

test("without a pattern every check runs and nothing is setup", () => {
  expect(run(null, [{ name: "a", sequence: "declared" }, { name: "b", needs: ["a"] }]).ran).toEqual(["a", "b"]);
});

test("a selected check first runs what it needs, prerequisites of prerequisites included, in order", () => {
  const steps = [
    { name: "open", sequence: "declared" as const },
    { name: "dock", needs: ["open"] },
    { name: "restore", needs: ["dock"] },
    { name: "close", needs: ["restore"] },
    { name: "alone" },
  ];
  expect(run("close", steps).ran).toEqual(["setup:open", "setup:dock", "setup:restore", "close"]);
  expect(run("alone", steps).ran).toEqual(["alone"]);
  expect(run("restore", steps).ran).toEqual(["setup:open", "setup:dock", "restore"]);
});

test("a prerequisite that already ran, as a match or as setup, doesn't run twice", () => {
  const steps = [
    { name: "open", sequence: "declared" as const },
    { name: "dock", needs: ["open"] },
    { name: "restore", needs: ["dock"] },
  ];
  expect(run("/dock|restore/", steps).ran).toEqual(["setup:open", "dock", "restore"]);
  expect(run("/open|dock/", steps).ran).toEqual(["open", "dock"]);
});

test("a chained sequence takes every earlier check as a prerequisite; a declared one none unless named", () => {
  const chained = [{ name: "a", sequence: "chained" as const }, { name: "b" }, { name: "c" }];
  expect(run("c", chained).ran).toEqual(["setup:a", "setup:b", "c"]);
  const declared = [{ name: "a", sequence: "declared" as const }, { name: "b" }, { name: "c" }];
  expect(run("c", declared).ran).toEqual(["c"]);
  // A new sequence forgets the old one's checks.
  const two = [{ name: "a", sequence: "chained" as const }, { name: "b", sequence: "chained" as const }, { name: "c" }];
  expect(run("c", two).ran).toEqual(["setup:b", "c"]);
});

test("a need that was never reached, or that loops, is an error rather than a silent pass", () => {
  expect(() => run("b", [{ name: "a", sequence: "declared" }, { name: "b", needs: ["missing"] }])).toThrow('needs "missing"');
  expect(() => run("b", [{ name: "a", sequence: "declared", needs: ["b"] }, { name: "b", needs: ["a"] }])).toThrow(); // a needs b before b was seen
});

test("matched counts selected checks, so a pattern that selects none can be told from one that ran", () => {
  expect(run("a", [{ name: "a", sequence: "declared" }, { name: "b" }]).sel.matched).toBe(1);
  expect(run("zzz", [{ name: "a", sequence: "declared" }, { name: "b" }]).sel.matched).toBe(0);
  expect(run("zzz", [{ name: "a", sequence: "declared" }]).sel.names).toEqual(["a"]);
});
