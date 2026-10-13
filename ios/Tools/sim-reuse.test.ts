import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseKept, hashApp, listKept, planApp, readReuseState, REUSE_VERSION, writeReuseState, type Kept, type ReuseState } from "./sim-reuse";

const state = (over: Partial<ReuseState> = {}): ReuseState => ({
  version: REUSE_VERSION, savedAt: 1000, port: 7831, scratch: "/tmp/p", daemonPid: 42, modeKey: "sheets", seeds: [], seeded: { a: 1 }, udids: ["U1"], appHash: "h1", ...over,
});
const kept = (home: string, over: Partial<ReuseState> = {}, daemonAlive = true): Kept => ({ home, state: state(over), daemonAlive });

test("chooseKept takes the newest kept state that fits", () => {
  const { pick, notes } = chooseKept([kept("/old", { savedAt: 1 }), kept("/new", { savedAt: 9 })], { modeKey: "sheets", seeds: [] });
  expect(pick?.home).toBe("/new");
  expect(notes).toEqual([]);
});

test("chooseKept explains each state it passes over, and says so when there is none", () => {
  expect(chooseKept([], { modeKey: "sheets", seeds: [] })).toEqual({ pick: null, notes: ["no kept state to reuse (run once with --keep)"] });
  const { pick, notes } = chooseKept(
    [kept("/dead", { savedAt: 5 }, false), kept("/other", { savedAt: 4, modeKey: "paging" }), kept("/stale", { savedAt: 3, version: 0 })],
    { modeKey: "sheets", seeds: [] },
  );
  expect(pick).toBeNull();
  expect(notes).toEqual([
    "/dead: its daemon (pid 42) isn't answering",
    "/other: it was seeded for paging, this run is sheets",
    `/stale: state is version 0, this sim-check reads ${REUSE_VERSION}`,
  ]);
});

test("a walk-through reuses a state that seeded at least what it needs, not less", () => {
  const have = { seeds: ["conductor", "approval"], modeKey: "walk" };
  expect(chooseKept([kept("/a", have)], { modeKey: "walk", seeds: ["conductor"] }).pick).not.toBeNull();
  const miss = chooseKept([kept("/a", have)], { modeKey: "walk", seeds: ["conductor", "noted"] });
  expect(miss.pick).toBeNull();
  expect(miss.notes[0]).toContain("didn't seed noted");
});

test("planApp keeps the app only for the same build, the same devices and this home's marker", () => {
  const now = { udids: ["U1"], appHash: "h1", home: "/h", markers: ["/h"] };
  const s = { udids: ["U1"], appHash: "h1" };
  expect(planApp(s, now)).toEqual({ install: false });
  expect(planApp(s, { ...now, appHash: "h2" })).toMatchObject({ install: true, reason: "the built app changed" });
  expect(planApp(s, { ...now, udids: ["U2"] })).toMatchObject({ install: true, reason: expect.stringContaining("simulators differ") });
  expect(planApp(s, { ...now, markers: [null] })).toMatchObject({ install: true, reason: expect.stringContaining("another run installed over it") });
  expect(planApp(s, { ...now, markers: ["/elsewhere"] })).toMatchObject({ install: true });
  expect(planApp({ udids: ["U1", "U2"], appHash: "h1" }, { ...now, markers: ["/h"] })).toMatchObject({ install: true }); // one device fewer
  expect(planApp({ udids: ["U1", "U2"], appHash: "h1" }, { ...now, udids: ["U1", "U2"], markers: ["/h", null] })).toMatchObject({ install: true });
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sim-reuse-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("hashApp follows content and layout, not timestamps", () => {
  const a = tmp();
  mkdirSync(join(a, "Frameworks"));
  writeFileSync(join(a, "Harness"), "binary");
  writeFileSync(join(a, "Frameworks", "x"), "x");
  const h = hashApp(a);
  writeFileSync(join(a, "Harness"), "binary"); // rewritten, same bytes
  expect(hashApp(a)).toBe(h);
  writeFileSync(join(a, "Harness"), "binarY");
  expect(hashApp(a)).not.toBe(h);
  writeFileSync(join(a, "Harness"), "binary");
  expect(hashApp(a)).toBe(h);
  writeFileSync(join(a, "Frameworks", "y"), "");
  expect(hashApp(a)).not.toBe(h); // an added (empty) file
  // The same bytes under another name is another app.
  const b = tmp();
  mkdirSync(join(b, "Frameworks"));
  writeFileSync(join(b, "Harness2"), "binary");
  writeFileSync(join(b, "Frameworks", "x"), "x");
  expect(hashApp(b)).not.toBe(h);
});

test("state round-trips through a kept home; junk reads as no state; listKept needs the keep file and a state", async () => {
  const t = tmp();
  const mk = (name: string, opts: { keep?: boolean; state?: ReuseState | string }) => {
    const home = join(t, name);
    mkdirSync(home);
    if (opts.keep) writeFileSync(join(home, "keep"), "");
    if (typeof opts.state === "string") writeFileSync(join(home, "reuse.json"), opts.state);
    else if (opts.state) writeReuseState(home, opts.state);
    return home;
  };
  mk("harness-sim-home-ok", { keep: true, state: state({ savedAt: 7 }) });
  mk("harness-sim-home-nokeep", { state: state() });
  mk("harness-sim-home-nostate", { keep: true });
  mk("harness-sim-home-junk", { keep: true, state: "{not json" });
  mk("harness-sim-home-shape", { keep: true, state: JSON.stringify({ port: "x" }) });
  mk("other-dir", { keep: true, state: state() });
  expect(readReuseState(join(t, "harness-sim-home-junk"))).toBeNull();
  expect(readReuseState(join(t, "harness-sim-home-shape"))).toBeNull();
  const found = await listKept(t, "harness-sim-home-", async (s) => s.port === 7831);
  expect(found.map((k) => [k.home.split("/").pop(), k.state.savedAt, k.daemonAlive])).toEqual([["harness-sim-home-ok", 7, true]]);
});
