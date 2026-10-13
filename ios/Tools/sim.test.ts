import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@harness/shared/testing";
import {
  acquire,
  acquirePool,
  checkDisk,
  deviceTypeFor,
  acquireReady,
  DiskLowError,
  NEW_SIM_GIB,
  MIN_FREE_GIB,
  poolNames,
  ensureDevice,
  etimeSeconds,
  extraRuntimes,
  isSharedDevice,
  keptSlots,
  poolSize,
  poolSlots,
  slotCandidates,
  type SlotView,
  lockHolder,
  markKept,
  parseSimDaemons,
  pinnedRuntime,
  reapIfStale,
  planReap,
  processStart,
  reap,
  releaseLock,
  tryLock,
  withLock,
  writeRunOwner,
  type Runtime,
  type Simctl,
  exportDeveloperDir,
  xcodeDeveloperDir,
  XCODE_27_DEVELOPER_DIR,
} from "./sim";

const iphone = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", name: "iPhone 18 Pro" };
const ipad = { identifier: "com.apple.CoreSimulator.SimDeviceType.iPad-Pro-11-inch-M5-12GB", name: "iPad Pro 11-inch (M5)" };
const runtime = (version: string, extra: Partial<Runtime> = {}): Runtime => ({
  identifier: `com.apple.CoreSimulator.SimRuntime.iOS-${version.replace(/\./g, "-")}`,
  version,
  platform: "iOS",
  isAvailable: true,
  supportedDeviceTypes: [iphone, ipad],
  ...extra,
});

// ---------------------------------------------------------------- runtime pinning

test("pinnedRuntime picks iOS 27.0 even when a newer and an older runtime are installed", () => {
  expect(pinnedRuntime([runtime("27.1"), runtime("27.0"), runtime("18.6")]).version).toBe("27.0");
  expect(pinnedRuntime([runtime("27.0.1"), runtime("27.1")]).version).toBe("27.0.1");
});

test("pinnedRuntime refuses when only other runtimes exist, and names them", () => {
  expect(() => pinnedRuntime([runtime("27.1"), runtime("18.6"), runtime("27.10")])).toThrow(/iOS 27\.0 simulator runtime isn't installed \(installed iOS runtimes: 27\.1, 18\.6, 27\.10\)/);
  expect(() => pinnedRuntime([])).toThrow(/installed iOS runtimes: none/);
});

test("pinnedRuntime ignores an unavailable 27.0 and other platforms' 27.0", () => {
  expect(() => pinnedRuntime([runtime("27.0", { isAvailable: false }), runtime("27.1")])).toThrow(/27\.0 \(unavailable\)/);
  expect(() => pinnedRuntime([runtime("27.0", { platform: "watchOS", identifier: "com.apple.CoreSimulator.SimRuntime.watchOS-27-0" })])).toThrow(/none/);
});

test("extraRuntimes names every iOS runtime but 27.0 (27.0.x counts as 27.0), and skips other platforms", () => {
  const image = (version: string, platformIdentifier = "com.apple.platform.iphonesimulator") => ({ identifier: `id-${version}`, version, platformIdentifier });
  const images = [image("18.6"), image("27.0"), image("27.0.1"), image("27.1"), image("27.10"), image("12.0", "com.apple.platform.watchsimulator")];
  expect(extraRuntimes(images).map((r) => r.version)).toEqual(["18.6", "27.1", "27.10"]);
  expect(extraRuntimes([image("27.0")])).toEqual([]);
});

test("deviceTypeFor prefers the iPhone 18 Pro and an iPad Pro 11-inch, else any of the kind", () => {
  expect(deviceTypeFor(runtime("27.0"), "iphone")).toEqual(iphone);
  expect(deviceTypeFor(runtime("27.0"), "ipad")).toEqual(ipad);
  const other = runtime("27.0", { supportedDeviceTypes: [{ identifier: "x.iPad-mini", name: "iPad mini (A17 Pro)" }, { identifier: "x.iPhone-17", name: "iPhone 17" }] });
  expect(deviceTypeFor(other, "iphone").name).toBe("iPhone 17");
  expect(deviceTypeFor(other, "ipad").name).toBe("iPad mini (A17 Pro)");
  expect(() => deviceTypeFor(runtime("27.0", { supportedDeviceTypes: [iphone] }), "ipad")).toThrow(/no iPad/);
});

test("checkDisk stops below the minimum", () => {
  expect(() => checkDisk(5, 4.9)).toThrow(/only 4\.9 GiB/);
  expect(() => checkDisk(5, 5)).not.toThrow();
});

// ---------------------------------------------------------------- locks

/** A PID that belonged to a process which has since exited. */
function deadPid(): number {
  const p = Bun.spawnSync(["true"]);
  expect(processStart(p.pid)).toBeNull();
  return p.pid;
}

/** A separate process that takes the lock, prints "locked", holds it for `ms`, then exits (letting go via its exit hook). */
async function holdInChild(dir: string, name: string, ms: number) {
  const script = `import { tryLock } from ${JSON.stringify(join(import.meta.dir, "sim.ts"))};
if (!tryLock(${JSON.stringify(name)}, ${JSON.stringify(dir)})) { console.log("busy"); process.exit(2); }
console.log("locked"); await Bun.sleep(${ms});`;
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first.trim()).toBe("locked");
  return child;
}

test("a held lock can't be taken a second time, and is free again once released", () => {
  const dir = tempDir();
  expect(tryLock("dev", dir)).toBe(true);
  expect(tryLock("dev", dir)).toBe(false);
  expect(lockHolder("dev", dir)?.pid).toBe(process.pid);
  releaseLock("dev", dir);
  expect(lockHolder("dev", dir)).toBeNull();
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("acquire waits while another process holds the lock, then gets it when that process exits", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 350);
  expect(tryLock("dev", dir)).toBe(false);
  expect(lockHolder("dev", dir)?.pid).toBe(child.pid);
  let waitedFor: number | undefined;
  const t0 = Date.now();
  const release = await acquire("dev", { dir, pollMs: 25, timeoutMs: 10_000, onWait: (h) => (waitedFor = h?.pid) });
  expect(waitedFor).toBe(child.pid);
  expect(Date.now() - t0).toBeGreaterThan(100);
  expect(lockHolder("dev", dir)?.pid).toBe(process.pid);
  release();
  await child.exited;
});

test("acquire times out while the holder is alive", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 5000);
  await expect(acquire("dev", { dir, pollMs: 25, timeoutMs: 200 })).rejects.toThrow(new RegExp(`timed out .*held by pid ${child.pid}`));
  child.kill();
  await child.exited;
});

test("a lock left by a process that died is taken over", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 60_000);
  child.kill("SIGKILL"); // no exit hook runs, so the lock file stays
  await child.exited;
  expect(readdirSync(dir)).toContain("dev.lock");
  expect(lockHolder("dev", dir)).toBeNull();
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("a dead PID, or a live PID with another start time (reused), counts as gone", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "a.lock"), JSON.stringify({ pid: deadPid(), start: "Thu Oct  1 08:00:00 2026", command: "gone", at: "" }));
  writeFileSync(join(dir, "b.lock"), JSON.stringify({ pid: process.pid, start: "Mon Jan  1 00:00:00 2001", command: "reused", at: "" }));
  writeFileSync(join(dir, "c.lock"), "not json");
  for (const name of ["a", "b", "c"]) {
    expect(tryLock(name, dir)).toBe(true);
    releaseLock(name, dir);
  }
});

test("releasing doesn't remove a lock someone else holds", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, "dev", 5000);
  releaseLock("dev", dir);
  expect(lockHolder("dev", dir)?.pid).toBe(child.pid);
  child.kill();
  await child.exited;
});

test("inside with-lock (HARNESS_SIM_LOCKED) the same lock doesn't wait on its parent, other locks still do", async () => {
  const dir = tempDir();
  const parent = await holdInChild(dir, "dev", 5000);
  process.env.HARNESS_SIM_LOCKED = "other,dev";
  try {
    const release = await acquire("dev", { dir, timeoutMs: 100 });
    release();
    expect(lockHolder("dev", dir)?.pid).toBe(parent.pid); // the no-op release left the parent's lock alone
    const sibling = await holdInChild(dir, "ipad", 5000);
    await expect(acquire("ipad", { dir, pollMs: 25, timeoutMs: 100 })).rejects.toThrow(/timed out/);
    sibling.kill();
  } finally {
    delete process.env.HARNESS_SIM_LOCKED;
    parent.kill();
  }
});

test("withLock lets go when fn throws", async () => {
  const dir = tempDir();
  await expect(withLock("dev", () => { throw new Error("boom"); }, { dir })).rejects.toThrow("boom");
  expect(existsSync(join(dir, "dev.lock"))).toBe(false);
  expect(tryLock("dev", dir)).toBe(true);
  releaseLock("dev", dir);
});

test("withLock runs callers one at a time", async () => {
  const dir = tempDir();
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: 4 }, () =>
      withLock("dev", async () => {
        most = Math.max(most, ++inside);
        await Bun.sleep(30);
        inside--;
      }, { dir, pollMs: 5 }),
    ),
  );
  expect(most).toBe(1);
});

// ---------------------------------------------------------------- ensureDevice

/** A simctl that knows the given runtimes and keeps devices in memory; create takes a moment, like the real one. */
function fakeSimctl(runtimes: Runtime[], devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean }[]> = {}) {
  const calls: string[][] = [];
  let n = 0;
  const run: Simctl = async (...args) => {
    calls.push(args);
    const [cmd, what] = args;
    if (cmd === "list" && what === "runtimes") return JSON.stringify({ runtimes });
    if (cmd === "list" && what === "devices") return JSON.stringify({ devices });
    if (cmd === "create") {
      await Bun.sleep(50);
      const udid = `UDID-${++n}`;
      (devices[args[3]!] ??= []).push({ udid, name: args[1]!, state: "Shutdown", isAvailable: true });
      return udid;
    }
    if (cmd === "boot") {
      const d = Object.values(devices).flat().find((x) => x.udid === args[1]);
      if (d!.state === "Booted") throw new Error("Unable to boot device in current state: Booted");
      d!.state = "Booted";
    }
    return "";
  };
  return { run, calls, devices };
}

test("concurrent ensureDevice calls create one device on iOS 27.0 and boot it once", async () => {
  const dir = tempDir();
  const sim = fakeSimctl([runtime("27.1"), runtime("27.0")]);
  const opts = { simctl: sim.run, lockDir: dir, freeGiB: () => 100, log: () => {} };
  const udids = await Promise.all([ensureDevice("harness-shared", opts), ensureDevice("harness-shared", opts), ensureDevice("harness-shared", opts)]);
  expect(new Set(udids)).toEqual(new Set(["UDID-1"]));
  const creates = sim.calls.filter((c) => c[0] === "create");
  expect(creates).toEqual([["create", "harness-shared", iphone.identifier, "com.apple.CoreSimulator.SimRuntime.iOS-27-0"]]);
  expect(sim.calls.filter((c) => c[0] === "boot")).toHaveLength(1);
});

test("ensureDevice reuses the device on 27.0 and refuses a same-named one on another runtime", async () => {
  const dir = tempDir();
  const opts = { lockDir: dir, freeGiB: () => 100, log: () => {} };
  const reuse = fakeSimctl([runtime("27.0")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "OLD", name: "harness-shared", state: "Booted", isAvailable: true }] });
  expect(await ensureDevice("harness-shared", { ...opts, simctl: reuse.run })).toBe("OLD");
  expect(reuse.calls.some((c) => c[0] === "create" || c[0] === "boot")).toBe(false);

  const wrong = fakeSimctl([runtime("27.0"), runtime("27.1")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-1": [{ udid: "X", name: "harness-shared", state: "Shutdown", isAvailable: true }] });
  await expect(ensureDevice("harness-shared", { ...opts, simctl: wrong.run })).rejects.toThrow(/exists on com\.apple\.CoreSimulator\.SimRuntime\.iOS-27-1/);
  expect(wrong.calls.some((c) => c[0] === "create")).toBe(false);
});

test("ensureDevice creates nothing without iOS 27.0 or without disk space", async () => {
  const dir = tempDir();
  const noRuntime = fakeSimctl([runtime("27.1"), runtime("18.6")]);
  await expect(ensureDevice("harness-shared", { simctl: noRuntime.run, lockDir: dir, freeGiB: () => 100 })).rejects.toThrow(/27\.0 simulator runtime isn't installed/);
  const full = fakeSimctl([runtime("27.0")]);
  await expect(ensureDevice("harness-shared", { simctl: full.run, lockDir: dir, freeGiB: () => 2 })).rejects.toThrow(/only 2\.0 GiB/);
  expect([...noRuntime.calls, ...full.calls].some((c) => c[0] === "create")).toBe(false);
  expect(existsSync(join(dir, "harness-shared.ensure.lock"))).toBe(false);
});

// ---------------------------------------------------------------- reaping

const dev = (name: string, state = "Booted", udid = name.replace(/\W+/g, "-")) => ({ udid, name, state, isAvailable: true });
const noDirs = { daemons: [], dirs: [] };

test("planReap shuts down only booted, unheld sim-check devices the caller doesn't want", () => {
  const devices = [dev("harness-shared"), dev("sim-check 2"), dev("sim-check 3"), dev("sim-check iPad 1"), dev("sim-check iPad 2", "Shutdown"), dev("harness-HARNESS-9"), { ...dev("sim-check 4"), isAvailable: false }];
  const plan = planReap({ devices, held: (n) => n === "sim-check 3", except: ["sim-check iPad 1"], ...noDirs });
  expect(plan.shutdown.map((d) => d.name)).toEqual(["sim-check 2"]);
});

test("planReap stops a daemon whose run died, but not a live run's, a kept one, or a young legacy one", () => {
  const T = "/tmp/x";
  const owned = (id: string, ownerAlive: boolean, keep = false) => ({ path: `${T}/harness-sim-home-${id}`, kind: "home" as const, ageSec: 10, owner: { pid: 1, start: "s", scratch: `${T}/harness-sim-projects-${id}` }, ownerAlive, keep });
  const legacy = (id: string, ageSec: number) => ({ path: `${T}/harness-sim-home-${id}`, kind: "home" as const, ageSec, owner: null, ownerAlive: false, keep: false });
  const d = (pid: number, id: string, ppid = 1, ageSec = 100) => ({ pid, ppid, ageSec, home: `${T}/harness-sim-home-${id}` });
  const plan = planReap({
    devices: [],
    held: () => false,
    dirs: [owned("dead", false), owned("live", true), owned("kept", false, true), legacy("old", 7200), legacy("young", 60), owned("parented", false)],
    daemons: [d(10, "dead"), d(11, "live"), d(12, "kept"), d(13, "old", 1, 7200), d(14, "young", 1, 60), d(15, "parented", 999)],
  });
  expect(plan.kill.map((p) => p.pid)).toEqual([10, 13]);
  // "parented" lost its owner but its daemon still has a parent (not reparented), so it stays, and its home with it.
  expect(plan.remove).toEqual([`${T}/harness-sim-home-dead`, `${T}/harness-sim-projects-dead`, `${T}/harness-sim-home-old`]);
});

test("planReap removes a stray projects dir only when no home claims it and it's six hours old", () => {
  const T = "/tmp/x";
  const proj = (id: string, ageSec: number) => ({ path: `${T}/harness-sim-projects-${id}`, kind: "projects" as const, ageSec, owner: null, ownerAlive: false, keep: false });
  const home = { path: `${T}/harness-sim-home-a`, kind: "home" as const, ageSec: 10, owner: { pid: 1, start: "s", scratch: `${T}/harness-sim-projects-claimed` }, ownerAlive: true, keep: false };
  const plan = planReap({ devices: [], held: () => false, daemons: [], dirs: [home, proj("claimed", 99999), proj("stray", 6 * 3600 + 1), proj("recent", 6 * 3600 - 1)] });
  expect(plan.remove).toEqual([`${T}/harness-sim-projects-stray`]);
});

test("planReap reaps an orphaned startDaemon home (harness-daemon-*) after a few minutes, and removes its dir", () => {
  const T = "/tmp/x";
  const home = (id: string, ageSec: number) => ({ path: `${T}/harness-daemon-${id}`, kind: "home" as const, ageSec, owner: null, ownerAlive: false, keep: false });
  const d = (pid: number, id: string, ageSec: number, ppid = 1) => ({ pid, ppid, ageSec, home: `${T}/harness-daemon-${id}` });
  const plan = planReap({
    devices: [],
    held: () => false,
    dirs: [home("orphan", 600), home("young", 60), home("parented", 900)],
    daemons: [d(1, "orphan", 600), d(2, "young", 60), d(3, "parented", 900, 999)],
  });
  expect(plan.kill.map((p) => p.pid)).toEqual([1]);
  expect(plan.remove).toEqual([`${T}/harness-daemon-orphan`]);
});

test("reap lists harness-daemon-* dirs in the temp dir", async () => {
  const tmp = tempDir("harness-reap-tmp-");
  mkdirSync(join(tmp, "harness-daemon-stale"));
  utimesSync(join(tmp, "harness-daemon-stale"), new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  mkdirSync(join(tmp, "harness-daemon-fresh"));
  const done = await reap({ tmp, lockDir: tempDir("harness-locks-"), simctl: async () => JSON.stringify({ devices: {} }), ps: () => "", log: () => {} });
  expect(done.remove).toEqual([join(tmp, "harness-daemon-stale")]);
  expect(existsSync(join(tmp, "harness-daemon-stale"))).toBe(false);
  expect(existsSync(join(tmp, "harness-daemon-fresh"))).toBe(true);
});

test("parseSimDaemons finds sim-check daemons by their HARNESS_HOME and reads their age", () => {
  const ps = [
    "  9519     1 03:17:29 bun /w/HARNESS-172/service/src/daemon.ts PATH=/bin HARNESS_HOME=/var/T/harness-sim-home-tf4UXu HARNESS_PORT=7848",
    "  3374  3325 1-02:03:04 bun /w/HARNESS-174/service/src/daemon.ts HARNESS_HOME=/var/T/harness-sim-home-fiOcad",
    "   700     1 10:00 bun /Applications/Harness.app/service/src/daemon.ts HARNESS_HOME=/Users/me/.harness",
    "   701     1 10:00 bun test HARNESS_HOME=/var/T/harness-sim-home-zzz",
    "  4400     1 20:00 bun /w/x/service/src/daemon.ts HARNESS_HOME=/var/T/harness-daemon-Ab12Cd HARNESS_PORT=1",
    "garbage",
  ].join("\n");
  expect(parseSimDaemons(ps)).toEqual([
    { pid: 9519, ppid: 1, ageSec: 3 * 3600 + 17 * 60 + 29, home: "/var/T/harness-sim-home-tf4UXu" },
    { pid: 3374, ppid: 3325, ageSec: 86400 + 2 * 3600 + 3 * 60 + 4, home: "/var/T/harness-sim-home-fiOcad" },
    { pid: 4400, ppid: 1, ageSec: 1200, home: "/var/T/harness-daemon-Ab12Cd" },
  ]);
  expect(etimeSeconds("05")).toBe(5);
  expect(etimeSeconds("01:05")).toBe(65);
});

test("reap shuts down unheld devices under their lock, stops an orphaned daemon and removes a dead run's dirs", async () => {
  const locks = tempDir();
  const tmp = tempDir();
  const mk = (name: string) => (mkdirSync(join(tmp, name)), join(tmp, name));
  const deadHome = mk("harness-sim-home-dead");
  const deadProjects = mk("harness-sim-projects-dead");
  writeFileSync(join(deadHome, "owner.json"), JSON.stringify({ pid: deadPid(), start: "gone", scratch: deadProjects }));
  const liveHome = mk("harness-sim-home-live");
  const liveProjects = mk("harness-sim-projects-live");
  writeRunOwner(liveHome, liveProjects);
  const keptHome = mk("harness-sim-home-kept");
  writeFileSync(join(keptHome, "owner.json"), JSON.stringify({ pid: deadPid(), start: "gone", scratch: join(tmp, "nope") }));
  markKept(keptHome);
  const stray = mk("harness-sim-projects-stray");
  const old = (Date.now() - 7 * 3600 * 1000) / 1000;
  utimesSync(stray, old, old);

  // A stand-in for an orphaned daemon: a real process the fake ps reports as reparented to launchd.
  const orphan = Bun.spawn(["sleep", "60"]);
  const ps = () => `${orphan.pid} 1 02:00:00 bun /w/service/src/daemon.ts HARNESS_HOME=${deadHome}\n`;
  const rt = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
  const sim = fakeSimctl([runtime("27.0")], { [rt]: [dev("sim-check 2"), dev("sim-check 3"), dev("harness-shared")] });
  expect(tryLock("sim-check 3", locks)).toBe(true);

  const done = await reap({ tmp, lockDir: locks, simctl: sim.run, ps, log: () => {} });
  expect(sim.calls.filter((c) => c[0] === "shutdown")).toEqual([["shutdown", "sim-check-2"]]);
  expect(done.shutdown.map((d) => d.name)).toEqual(["sim-check 2"]);
  expect(lockHolder("sim-check 2", locks)).toBeNull();
  expect(lockHolder("sim-check 3", locks)?.pid).toBe(process.pid);
  expect(await orphan.exited).not.toBe(0);
  expect(readdirSync(tmp).sort()).toEqual(["harness-sim-home-kept", "harness-sim-home-live", "harness-sim-projects-live"]);
  releaseLock("sim-check 3", locks);
});

test("planReap leaves kept homes alone, and stops their daemons and removes them with includeKept (reap --kept)", () => {
  const T = "/tmp/x";
  const kept = { path: `${T}/harness-sim-home-k`, kind: "home" as const, ageSec: 10, owner: { pid: 1, start: "s", scratch: `${T}/harness-sim-projects-k` }, ownerAlive: false, keep: true };
  const live = { ...kept, path: `${T}/harness-sim-home-l`, owner: { pid: 2, start: "s", scratch: `${T}/harness-sim-projects-l` }, ownerAlive: true, keep: false };
  const input = { devices: [], held: () => false, dirs: [kept, live], daemons: [{ pid: 1, ppid: 1, ageSec: 99, home: kept.path }, { pid: 2, ppid: 1, ageSec: 99, home: live.path }] };
  expect(planReap(input)).toEqual({ shutdown: [], kill: [], remove: [] });
  const all = planReap({ ...input, includeKept: true });
  expect(all.kill.map((p) => p.pid)).toEqual([1]); // not the live run's daemon
  expect(all.remove).toEqual([kept.path, `${T}/harness-sim-projects-k`]);
  // A --reuse run that attached to the kept home took over its owner file: it's live now, so reap --kept leaves it be.
  const attached = { ...kept, owner: { pid: 3, start: "s", scratch: kept.owner.scratch }, ownerAlive: true };
  expect(planReap({ ...input, dirs: [attached, live], includeKept: true })).toEqual({ shutdown: [], kill: [], remove: [] });
});

// ---------------------------------------------------------------- the pool

const view = (name: string, o: Partial<SlotView> = {}): SlotView => ({ name, exists: true, booted: true, held: false, ...o });
const A = "harness-shared";
const B = "harness-shared-2";

test("poolSlots keeps the existing harness-shared as slot 1; poolSize reads HARNESS_SIM_POOL_SIZE and ignores junk", () => {
  expect(poolSlots(3)).toEqual([A, B, "harness-shared-3"]);
  expect(poolSize({})).toBe(2);
  expect(poolSize({ HARNESS_SIM_POOL_SIZE: "3" })).toBe(3);
  for (const bad of ["0", "-1", "x", "1.5", ""]) expect(poolSize({ HARNESS_SIM_POOL_SIZE: bad })).toBe(2);
  expect(isSharedDevice(B) && isSharedDevice(A) && isSharedDevice("harness-shared-ipad")).toBe(true);
  expect(isSharedDevice("harness-shared-x") || isSharedDevice("sim-check 2")).toBe(false);
});

test("slotCandidates: the first free existing slot wins, held ones are skipped, preferred ones go first", () => {
  expect(slotCandidates([view(A), view(B)], { diskOk: true })).toEqual([A, B]);
  expect(slotCandidates([view(A, { held: true }), view(B)], { diskOk: true })).toEqual([B]);
  expect(slotCandidates([view(A), view(B)], { diskOk: true, prefer: [B] })).toEqual([B, A]);
  expect(slotCandidates([view(A, { held: true }), view(B, { held: true })], { diskOk: true, prefer: [B] })).toEqual([]);
});

test("slotCandidates: the pool grows lazily, and only with disk to spare", () => {
  const grow = [view(A, { held: true }), view(B, { exists: false, booted: false })];
  expect(slotCandidates(grow, { diskOk: true })).toEqual([B]);
  expect(slotCandidates(grow, { diskOk: false })).toEqual([]); // wait on the first slot instead
  // an existing slot is taken before a missing one is created
  expect(slotCandidates([view(A, { exists: false, booted: false }), view(B)], { diskOk: false })).toEqual([B]);
  expect(slotCandidates([view(A, { exists: false, booted: false }), view(B)], { diskOk: true })).toEqual([B, A]);
});

test("slotCandidates: creating needs the growth margin (roomForNew), not just MIN_FREE_GIB; existing slots only need MIN_FREE_GIB", () => {
  const grow = [view(A, { held: true }), view(B, { exists: false, booted: false })];
  expect(slotCandidates(grow, { diskOk: true, roomForNew: false })).toEqual([]);
  expect(slotCandidates(grow, { diskOk: true, roomForNew: true })).toEqual([B]);
  expect(slotCandidates([view(A, { held: true }), view(B, { booted: false })], { diskOk: true, roomForNew: false })).toEqual([B]);
});

test("slotCandidates: under low disk a shut-down slot beyond the first isn't booted, a booted one still is, the first always is", () => {
  expect(slotCandidates([view(A, { held: true }), view(B, { booted: false })], { diskOk: false })).toEqual([]);
  expect(slotCandidates([view(A, { held: true }), view(B)], { diskOk: false })).toEqual([B]);
  expect(slotCandidates([view(A, { booted: false }), view(B)], { diskOk: false })).toEqual([A, B]);
});

const slotDev = (name: string, state = "Booted", udid = `U-${name}`) => ({ udid, name, state, isAvailable: true });

test("acquirePool: two callers get different slots, a third waits for one to be released", async () => {
  const dir = tempDir();
  const opts = { dir, pollMs: 10, devices: async () => [slotDev(A), slotDev(B)], freeGiB: () => 100 };
  const first = await acquirePool(opts);
  const second = await acquirePool(opts);
  expect([first.name, second.name].sort()).toEqual([A, B]);
  let got: string | null = null;
  const third = acquirePool(opts).then((r) => ((got = r.name), r));
  await Bun.sleep(60);
  expect(got).toBeNull();
  second.release();
  expect((await third).name).toBe(second.name);
  first.release();
  (await third).release();
});

test("acquirePool: a slot whose holder died is taken over, and under low disk it waits instead of creating slot 2", async () => {
  const dir = tempDir();
  const child = await holdInChild(dir, A, 60_000);
  const low = { dir, pollMs: 10, devices: async () => [slotDev(A)], freeGiB: () => 1 };
  await expect(acquirePool({ ...low, timeoutMs: 100 })).rejects.toThrow(/timed out waiting for a shared simulator.*pid \d+.*disk is low/);
  expect(existsSync(join(dir, `${B}.lock`))).toBe(false);
  child.kill("SIGKILL");
  await child.exited;
  const got = await acquirePool(low);
  expect(got.name).toBe(A); // the dead holder's lock was reaped, per slot
  got.release();
  // with room, the same situation (slot 1 held) creates slot 2
  const again = await holdInChild(dir, A, 60_000);
  const roomy = await acquirePool({ ...low, freeGiB: () => 50 });
  expect(roomy.name).toBe(B);
  roomy.release();
  again.kill();
});

test("acquirePool inside with-lock returns the slot the parent holds, even when it's slot 2", async () => {
  const dir = tempDir();
  const parent = await holdInChild(dir, B, 5000);
  process.env.HARNESS_SIM_LOCKED = B;
  try {
    const got = await acquirePool({ dir, timeoutMs: 100, devices: async () => [slotDev(A), slotDev(B)] });
    expect(got.name).toBe(B);
    got.release();
    expect(lockHolder(B, dir)?.pid).toBe(parent.pid);
  } finally {
    delete process.env.HARNESS_SIM_LOCKED;
    parent.kill();
  }
});

test("keptSlots maps the kept --reuse states' simulators to pool slots, newest first, ignoring other devices", async () => {
  const { writeReuseState } = await import("./sim-reuse");
  const tmp = tempDir();
  const keep = (name: string, savedAt: number, udids: string[]) => {
    const home = join(tmp, `harness-sim-home-${name}`);
    mkdirSync(home);
    writeFileSync(join(home, "keep"), "");
    writeReuseState(home, { version: 2, savedAt, port: 1, scratch: "", daemonPid: 1, modeKey: "walk", seeds: [], seeded: {}, udids, appHash: "", installed: [], repoRoot: "", serviceHash: "" });
  };
  keep("old", 1, ["U-" + A]);
  keep("new", 2, ["U-" + B, "U-sim-check 2", "gone"]);
  expect(await keptSlots(tmp, async () => [slotDev(A), slotDev(B), slotDev("sim-check 2")], async () => true)).toEqual([B, A]);
});

test("acquirePool creates a new slot only at NEW_SIM_GIB free, not at MIN_FREE_GIB", async () => {
  expect(NEW_SIM_GIB).toBeGreaterThan(MIN_FREE_GIB);
  const dir = tempDir();
  const holder = await holdInChild(dir, A, 60_000);
  const base = { dir, pollMs: 10, devices: async () => [slotDev(A)] };
  await expect(acquirePool({ ...base, freeGiB: () => NEW_SIM_GIB - 0.5, timeoutMs: 80 })).rejects.toThrow(/disk is low/);
  const got = await acquirePool({ ...base, freeGiB: () => NEW_SIM_GIB });
  expect(got.name).toBe(B);
  got.release();
  holder.kill();
});

test("acquirePool with no simulator at all and too little disk fails at once instead of waiting", async () => {
  await expect(acquirePool({ dir: tempDir(), devices: async () => [], freeGiB: () => 6, timeoutMs: 60_000 })).rejects.toBeInstanceOf(DiskLowError);
});

test("acquirePool polls simctl only while a slot is unheld", async () => {
  const dir = tempDir();
  const a = await holdInChild(dir, A, 60_000);
  const b = await holdInChild(dir, B, 60_000);
  let listed = 0;
  const devices = async () => (listed++, [slotDev(A), slotDev(B)]);
  await expect(acquirePool({ dir, devices, pollMs: 10, timeoutMs: 120, freeGiB: () => 100 })).rejects.toThrow(/timed out/);
  expect(listed).toBe(0);
  a.kill();
  b.kill();
});

test("acquireReady: when creating the slot is refused for disk after it was locked, it lets go and takes an existing slot instead", async () => {
  const dir = tempDir();
  const holder = await holdInChild(dir, A, 60_000);
  const sim = fakeSimctl([runtime("27.0")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "UA", name: A, state: "Booted", isAvailable: true }] });
  // The pool check saw room for slot 2 (50 GiB); by the time ensureDevice looks, another run used it (1 GiB).
  const pool = { dir, pollMs: 10, devices: async () => [slotDev(A)], freeGiB: () => 50 };
  const pending = acquireReady(pool, { simctl: sim.run, lockDir: dir, freeGiB: () => 1, log: () => {} });
  await Bun.sleep(100);
  expect(lockHolder(B, dir)).toBeNull(); // slot 2 was let go, not kept
  expect(sim.calls.some((c) => c[0] === "create")).toBe(false);
  holder.kill("SIGKILL");
  const got = await pending;
  expect([got.name, got.udid]).toEqual([A, "UA"]);
  got.release();
});

test("acquireReady: a slot refused for disk is tried again once the disk has room, rather than waiting on a held slot", async () => {
  const dir = tempDir();
  const holder = await holdInChild(dir, A, 60_000);
  const sim = fakeSimctl([runtime("27.0")], { "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "UA", name: A, state: "Booted", isAvailable: true }] });
  let free = 1;
  const pool = { dir, pollMs: 10, timeoutMs: 5000, devices: async () => (await sim.run("list", "devices", "--json").then((o) => Object.values((JSON.parse(o) as { devices: Record<string, { udid: string; name: string; state: string; isAvailable: boolean }[]> }).devices).flat())), freeGiB: () => 50 };
  const pending = acquireReady(pool, { simctl: sim.run, lockDir: dir, freeGiB: () => free, log: () => {} });
  await Bun.sleep(150);
  expect(sim.calls.some((c) => c[0] === "create")).toBe(false); // refused, and A is held
  free = 50;
  const got = await pending;
  expect(got.name).toBe(B); // created, not waited out
  expect(sim.calls.some((c) => c[0] === "create")).toBe(true);
  got.release();
  holder.kill("SIGKILL");
});

test("reapIfStale leaves a lock another process created after the stale one was already gone", () => {
  const dir = tempDir();
  const path = join(dir, "x.lock");
  const live = JSON.stringify({ pid: process.pid, start: processStart(process.pid), command: "other", at: new Date().toISOString() });
  // No lock file at the re-read; a live holder appears right after it. Removing "the stale lock" now would delete theirs.
  reapIfStale(path, () => writeFileSync(path, live));
  expect(existsSync(path)).toBe(true);
});

test("reapIfStale still removes a lock whose holder is dead", () => {
  const dir = tempDir();
  const path = join(dir, "y.lock");
  writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, start: "never", command: "gone", at: "" }));
  reapIfStale(path);
  expect(existsSync(path)).toBe(false);
});

test("ensureDevice creates a simulator only at NEW_SIM_GIB free, and one at a time across names", async () => {
  const dir = tempDir();
  const low = fakeSimctl([runtime("27.0")]);
  await expect(ensureDevice(B, { simctl: low.run, lockDir: dir, freeGiB: () => NEW_SIM_GIB - 1, log: () => {} })).rejects.toBeInstanceOf(DiskLowError);
  expect(low.calls.some((c) => c[0] === "create")).toBe(false);
  const sim = fakeSimctl([runtime("27.0")]);
  let active = 0;
  let most = 0;
  const run: Simctl = async (...args) => {
    if (args[0] === "create") {
      most = Math.max(most, ++active);
      await Bun.sleep(40);
      active--;
    }
    return sim.run(...args);
  };
  const opts = { simctl: run, lockDir: dir, freeGiB: () => 100, log: () => {} };
  await Promise.all([ensureDevice(A, opts), ensureDevice(B, opts)]);
  expect(most).toBe(1);
});

test("poolNames lists configured slots plus any existing harness-shared-N, in slot order, never the iPad", () => {
  const dev = (name: string) => slotDev(name);
  expect(poolNames([dev(A)], 2)).toEqual([A, B]);
  expect(poolNames([dev("harness-shared-3"), dev(A), dev("harness-shared-ipad"), dev("sim-check 2"), dev("harness-shared-10")], 2)).toEqual([A, B, "harness-shared-3", "harness-shared-10"]);
});

test("keptSlots ignores kept states whose daemon is dead", async () => {
  const { writeReuseState } = await import("./sim-reuse");
  const tmp = tempDir();
  const keep = (name: string, savedAt: number, udid: string) => {
    const home = join(tmp, `harness-sim-home-${name}`);
    mkdirSync(home);
    writeFileSync(join(home, "keep"), "");
    writeReuseState(home, { version: 2, savedAt, port: 1, scratch: "", daemonPid: savedAt, modeKey: "walk", seeds: [], seeded: {}, udids: [udid], appHash: "", installed: [], repoRoot: "", serviceHash: "" });
  };
  keep("dead-newer", 2, "U-" + B);
  keep("live-older", 1, "U-" + A);
  expect(await keptSlots(tmp, async () => [slotDev(A), slotDev(B)], async (s) => s.daemonPid === 1)).toEqual([A]);
});

test("xcodeDeveloperDir defaults to Xcode 27.0 and keeps a caller's value", () => {
  expect(xcodeDeveloperDir({})).toBe(XCODE_27_DEVELOPER_DIR);
  expect(xcodeDeveloperDir({ DEVELOPER_DIR: "" })).toBe(XCODE_27_DEVELOPER_DIR);
  expect(xcodeDeveloperDir({ DEVELOPER_DIR: "/x/Developer" })).toBe("/x/Developer");
});

test("exportDeveloperDir leaves DEVELOPER_DIR set in the env children inherit", async () => {
  const env: Record<string, string | undefined> = {};
  expect(exportDeveloperDir(env)).toBe(XCODE_27_DEVELOPER_DIR);
  expect(env.DEVELOPER_DIR).toBe(XCODE_27_DEVELOPER_DIR);
  const kept: Record<string, string | undefined> = { DEVELOPER_DIR: "/x/Developer" };
  exportDeveloperDir(kept);
  expect(kept.DEVELOPER_DIR).toBe("/x/Developer");
  // Bun.spawn without an env option uses the environment from startup, not later process.env writes; a child spawned with env: process.env sees it.
  const real = { ...process.env };
  delete real.DEVELOPER_DIR;
  const p = Bun.spawn(["bun", "-e", `import { exportDeveloperDir } from ${JSON.stringify(import.meta.dir + "/sim")}; exportDeveloperDir(); console.log(Bun.spawnSync(["/usr/bin/env"], { env: process.env }).stdout.toString())`], { env: real, stdout: "pipe" });
  expect(await new Response(p.stdout).text()).toContain(`DEVELOPER_DIR=${XCODE_27_DEVELOPER_DIR}`);
});
