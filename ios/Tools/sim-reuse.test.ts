import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimKept, staleAppNote, chooseKept, hashApp, hashService, listKept, planApp, deviceAppUrl, planDeviceInstall, readReuseState, REUSE_VERSION, writeReuseState, type Kept, type ReuseState } from "./sim-reuse";

const state = (over: Partial<ReuseState> = {}): ReuseState => ({
  version: REUSE_VERSION, savedAt: 1000, port: 7831, scratch: "/tmp/p", daemonPid: 42, modeKey: "sheets", seeds: [], seeded: { a: 1 }, udids: ["U1"], appHash: "h1", installed: ["i1"], repoRoot: "/repo", serviceHash: "s1", ...over,
});
const W = { modeKey: "sheets", seeds: [] as string[], repoRoot: "/repo", serviceHash: "s1" };
const kept = (home: string, over: Partial<ReuseState> = {}, daemonAlive = true): Kept => ({ home, state: state(over), daemonAlive });

test("chooseKept takes the newest kept state that fits", () => {
  const { pick, notes } = chooseKept([kept("/old", { savedAt: 1 }), kept("/new", { savedAt: 9 })], W);
  expect(pick?.home).toBe("/new");
  expect(notes).toEqual([]);
});

test("chooseKept explains each state it passes over, and says so when there is none", () => {
  expect(chooseKept([], W)).toEqual({ pick: null, notes: ["no kept state to reuse (run once with --keep)"] });
  const { pick, notes } = chooseKept(
    [kept("/dead", { savedAt: 5 }, false), kept("/other", { savedAt: 4, modeKey: "paging" }), kept("/stale", { savedAt: 3, version: 0 })],
    W,
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
  expect(chooseKept([kept("/a", have)], { ...W, modeKey: "walk", seeds: ["conductor"] }).pick).not.toBeNull();
  const miss = chooseKept([kept("/a", have)], { ...W, modeKey: "walk", seeds: ["conductor", "noted"] });
  expect(miss.pick).toBeNull();
  expect(miss.notes[0]).toContain("didn't seed noted");
});

test("chooseKept won't attach to a daemon running another checkout's or edited service code", () => {
  const other = chooseKept([kept("/a", { repoRoot: "/other" })], W);
  expect(other.pick).toBeNull();
  expect(other.notes[0]).toContain("/other");
  const edited = chooseKept([kept("/a", { serviceHash: "s0" })], W);
  expect(edited.pick).toBeNull();
  expect(edited.notes[0]).toContain("service/src changed");
});

test("hashService follows the service sources", () => {
  const root = mkdtempSync(join(tmpdir(), "svc-"));
  mkdirSync(join(root, "service/src"), { recursive: true });
  writeFileSync(join(root, "service/src/a.ts"), "1");
  const h = hashService(root);
  writeFileSync(join(root, "service/src/a.ts"), "2");
  expect(hashService(root)).not.toBe(h);
  rmSync(root, { recursive: true, force: true });
});

test("planApp keeps the app only for the same build, the same devices and this home's marker", () => {
  const now = { udids: ["U1"], appHash: "h1", home: "/h", markers: ["/h"], installed: ["i1"] };
  const s = { udids: ["U1"], appHash: "h1", installed: ["i1"] };
  expect(planApp(s, { ...now, installed: ["i2"] })).toMatchObject({ install: true, reason: expect.stringContaining("installed bundle") });
  expect(planApp(s, { ...now, installed: [null] })).toMatchObject({ install: true });
  expect(planApp(s, now)).toEqual({ install: false });
  expect(planApp(s, { ...now, appHash: "h2" })).toMatchObject({ install: true, reason: "the built app changed" });
  expect(planApp(s, { ...now, udids: ["U2"] })).toMatchObject({ install: true, reason: expect.stringContaining("simulators differ") });
  expect(planApp(s, { ...now, markers: [null] })).toMatchObject({ install: true, reason: expect.stringContaining("another run installed over it") });
  expect(planApp(s, { ...now, markers: ["/elsewhere"] })).toMatchObject({ install: true });
  expect(planApp({ udids: ["U1", "U2"], appHash: "h1", installed: ["i1", "i2"] }, { ...now, markers: ["/h"] })).toMatchObject({ install: true }); // one device fewer
  expect(planApp({ udids: ["U1", "U2"], appHash: "h1", installed: ["i1", "i2"] }, { ...now, udids: ["U1", "U2"], markers: ["/h", null], installed: ["i1", "i2"] })).toMatchObject({ install: true });
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

test("a device install is skipped only for the recorded build that is still on the device", () => {
  const base = { installed: { hash: "h1", url: "file:///A/Harness.app" }, builtHash: "h1", deviceUrl: "file:///A/Harness.app" };
  expect(planDeviceInstall(base)).toEqual({ install: false });
  expect(planDeviceInstall({ ...base, builtHash: "h2" }).install).toBe(true);
  expect(planDeviceInstall({ ...base, installed: null }).install).toBe(true);
  // Deleted from the phone since: the record alone doesn't count.
  expect(planDeviceInstall({ ...base, deviceUrl: null }).install).toBe(true);
  // Installed over by another worktree or Xcode: the device's location moved.
  expect(planDeviceInstall({ ...base, deviceUrl: "file:///B/Harness.app" }).install).toBe(true);
});

test("deviceAppUrl matches the bundle id exactly and tolerates bad output", () => {
  const json = JSON.stringify({ result: { apps: [
    { bundleIdentifier: "com.markhuot.harness.widgets", url: "file:///W/" },
    { bundleIdentifier: "com.markhuot.harness", url: "file:///A/Harness.app/" },
  ] } });
  expect(deviceAppUrl(json, "com.markhuot.harness")).toBe("file:///A/Harness.app/");
  expect(deviceAppUrl(json, "com.markhuot")).toBeNull();
  expect(deviceAppUrl("not json", "com.markhuot.harness")).toBeNull();
  expect(deviceAppUrl("{}", "com.markhuot.harness")).toBeNull();
});

test("claimKept lets the first run take the home and tells the second who has it", () => {
  const taken = new Set<string>();
  const lock = (n: string) => (taken.has(n) ? false : (taken.add(n), true));
  const holder = () => ({ pid: 77, command: "sim-check.ts --reuse" });
  expect(claimKept("harness-sim-home-a", lock, holder)).toBeNull();
  expect(claimKept("harness-sim-home-a", lock, holder)).toMatch(/another --reuse run holds harness-sim-home-a \(pid 77: sim-check.ts --reuse\)/);
  // A different home is free.
  expect(claimKept("harness-sim-home-b", lock, holder)).toBeNull();
});

test("staleAppNote names a Swift file newer than the built app, and stays quiet otherwise", () => {
  const t = mkdtempSync(join(tmpdir(), "stale-app-"));
  try {
    const app = join(t, "Harness.app");
    const src = join(t, "src", "Views");
    mkdirSync(app);
    mkdirSync(src, { recursive: true });
    const at = (p: string, secs: number) => utimesSync(p, secs, secs);
    writeFileSync(join(src, "Old.swift"), "x");
    writeFileSync(join(src, "notes.md"), "x");
    at(app, 2000);
    at(join(src, "Old.swift"), 1000);
    at(join(src, "notes.md"), 3000);
    // Only older Swift, plus a newer non-Swift file: nothing to say.
    expect(staleAppNote(app, [join(t, "src")])).toBeNull();
    writeFileSync(join(src, "New.swift"), "x");
    at(join(src, "New.swift"), 3000);
    expect(staleAppNote(app, [join(t, "src"), join(t, "missing")])).toMatch(/New\.swift.*--rebuild/);
    // No built app (or an unreadable source dir): not this check's business.
    expect(staleAppNote(join(t, "none.app"), [join(t, "src")])).toBeNull();
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
