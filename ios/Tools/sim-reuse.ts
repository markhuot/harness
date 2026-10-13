// What `sim-check --reuse` needs to pick up where a `--keep`'d run left off: the state file a run
// writes into its kept home, how it decides whether that state still fits the run asking for it, and
// the hash that says whether the built app changed. Nothing here touches a simulator or the daemon,
// so the decisions are unit-tested (sim-reuse.test.ts); sim-check.ts does the attaching.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Written into a kept sim-check home, next to its `keep` file. */
export const REUSE_FILE = "reuse.json";
/** Bump when the state's meaning changes, so an old file is stale rather than misread. */
export const REUSE_VERSION = 2;

export interface ReuseState {
  version: number;
  /** When the run that left it ended (ms since the epoch); the newest fitting state wins. */
  savedAt: number;
  port: number;
  /** The projects dir the daemon's seeded projects live in. */
  scratch: string;
  /** The daemon's pid, to tell a kept daemon that still runs from a leftover file. */
  daemonPid: number;
  /** Which seed the run made: "walk", "sheets", "paging", … (see modeKeyOf in sim-check.ts). */
  modeKey: string;
  /** For the walk-through, the seeds it made (`SeedName`s); a run that needs fewer fits. */
  seeds: string[];
  /** What the seed returned, as JSON (tickets and projects, by id and key). */
  seeded: unknown;
  /** The simulators the app was installed and paired on, in order. */
  udids: string[];
  /** hashApp of the app that was installed. */
  appHash: string;
  /** hashApp of the bundle on each simulator right after the install, to notice a plain `simctl install` over it later. */
  installed: string[];
  /** The checkout whose service code the daemon runs; another worktree's run must not attach to it. */
  repoRoot: string;
  /** hashApp of that checkout's service/src when the daemon started; edited code means a stale daemon. */
  serviceHash: string;
}

export interface Want {
  modeKey: string;
  seeds: readonly string[];
  repoRoot: string;
  serviceHash: string;
}

export interface Kept {
  home: string;
  state: ReuseState;
  /** Its daemon answers (the pid is alive and /health is ok). */
  daemonAlive: boolean;
}

export interface Chosen {
  pick: Kept | null;
  /** One line per state looked at and why it didn't fit, or why none existed; printed so a fall-back is never silent. */
  notes: string[];
}

/**
 * The newest kept state this run can attach to: its daemon is up, its seed is the run's (same mode,
 * covering the seeds it needs), and it's a version this code reads. Anything else is a note.
 */
export function chooseKept(candidates: readonly Kept[], want: Want): Chosen {
  if (!candidates.length) return { pick: null, notes: ["no kept state to reuse (run once with --keep)"] };
  const notes: string[] = [];
  const newestFirst = [...candidates].sort((a, b) => b.state.savedAt - a.state.savedAt);
  for (const k of newestFirst) {
    const why = misfit(k, want);
    if (!why) return { pick: k, notes };
    notes.push(`${k.home}: ${why}`);
  }
  return { pick: null, notes };
}

function misfit(k: Kept, want: Want): string | null {
  const s = k.state;
  if (s.version !== REUSE_VERSION) return `state is version ${s.version}, this sim-check reads ${REUSE_VERSION}`;
  if (!k.daemonAlive) return `its daemon (pid ${s.daemonPid}) isn't answering`;
  if (s.repoRoot !== want.repoRoot) return `its daemon runs the service from ${s.repoRoot}, not ${want.repoRoot}`;
  if (s.serviceHash !== want.serviceHash) return "service/src changed since its daemon started";
  if (s.modeKey !== want.modeKey) return `it was seeded for ${s.modeKey}, this run is ${want.modeKey}`;
  const have = new Set(s.seeds);
  const missing = want.seeds.filter((n) => !have.has(n));
  if (missing.length) return `it didn't seed ${missing.join(", ")}`;
  return null;
}

export type AppPlan = { install: false } | { install: true; reason: string };

/** The default sim-check writes into the paired app (HarnessSimCheckHome): the kept home it was paired for. */
export const MARKER_KEY = "HarnessSimCheckHome";

/**
 * Whether the app on the simulators is still this run's: installed from the same build, on the same
 * devices, and still the one paired for this home. Another run or agent that installed over the
 * shared simulator wiped the marker (it uninstalls first), so a changed marker means the app is theirs;
 * an install that keeps the data container (dev-sim, by hand) leaves the marker but changes the bundle.
 * Otherwise it's installed (and paired) again, against the same daemon.
 */
export function planApp(
  state: Pick<ReuseState, "udids" | "appHash" | "installed">,
  now: { udids: readonly string[]; appHash: string; home: string; markers: readonly (string | null)[]; installed: readonly (string | null)[] },
): AppPlan {
  if (state.appHash !== now.appHash) return { install: true, reason: "the built app changed" };
  if (state.udids.length !== now.udids.length || state.udids.some((u, i) => u !== now.udids[i])) return { install: true, reason: "the simulators differ from the kept run's" };
  if (now.markers.some((m) => m !== now.home)) return { install: true, reason: "the app on the simulator isn't the one paired for this daemon (another run installed over it)" };
  if (now.installed.some((h, i) => h !== state.installed[i])) return { install: true, reason: "the installed bundle isn't the one this run installed (installed over by dev-sim or by hand)" };
  return { install: false };
}

/**
 * Whether `build.ts device` has to install the app again. `deviceUrl` is where the device says the
 * app lives now (null: not installed); it changes with every install, whoever made it. So an unchanged
 * build is skipped only when this checkout's record (the build's hashApp and that url) still matches,
 * and another worktree, Xcode or TestFlight installing over it forces a reinstall. Where the app's
 * data must stay, as on a phone, an unchanged build is left alone.
 */
export function planDeviceInstall(o: { installed: { hash: string; url: string } | null; builtHash: string; deviceUrl: string | null }): AppPlan {
  if (o.deviceUrl === null) return { install: true, reason: "the app isn't on the device" };
  if (o.installed === null) return { install: true, reason: "no record of an earlier install" };
  if (o.installed.url !== o.deviceUrl) return { install: true, reason: "the app on the device isn't the one this checkout installed" };
  if (o.installed.hash !== o.builtHash) return { install: true, reason: "the built app changed" };
  return { install: false };
}

/** The device's install location for `bundleId` in `devicectl device info apps --json-output`, or null. */
export function deviceAppUrl(json: string, bundleId: string): string | null {
  try {
    const apps = JSON.parse(json)?.result?.apps;
    const app = Array.isArray(apps) ? apps.find((a: { bundleIdentifier?: unknown }) => a?.bundleIdentifier === bundleId) : undefined;
    return typeof app?.url === "string" ? app.url : null;
  } catch {
    return null;
  }
}

/**
 * A hash of the built app: every file's relative path and bytes, in a fixed order. Content, not
 * mtimes, since a rebuild that changes nothing rewrites every timestamp.
 */
export function hashApp(dir: string): string {
  return hashTree(dir);
}

/** The service code a daemon runs from: a hash of `<repo>/service/src`. */
export function hashService(repoRoot: string): string {
  return hashTree(join(repoRoot, "service/src"));
}

function hashTree(dir: string): string {
  const h = createHash("sha256");
  const walk = (rel: string) => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const p = join(rel, name);
      const full = join(dir, p);
      const st = statSync(full);
      if (st.isDirectory()) walk(p);
      else {
        h.update(`${p}\0${st.size}\0`);
        h.update(readFileSync(full));
      }
    }
  };
  walk("");
  return h.digest("hex");
}

export function writeReuseState(home: string, state: ReuseState): void {
  writeFileSync(join(home, REUSE_FILE), JSON.stringify(state));
}

export function readReuseState(home: string): ReuseState | null {
  try {
    const s = JSON.parse(readFileSync(join(home, REUSE_FILE), "utf8")) as ReuseState;
    return s && typeof s.port === "number" && typeof s.version === "number" && Array.isArray(s.udids) && Array.isArray(s.seeds) ? s : null;
  } catch {
    return null;
  }
}

/** The kept homes under `tmp` (a `keep` file and a state file), with their states; `alive` says whether the daemon answers. */
export async function listKept(tmp: string, homePrefix: string, alive: (s: ReuseState, home: string) => Promise<boolean>): Promise<Kept[]> {
  const out: Kept[] = [];
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith(homePrefix)) continue;
    const home = join(tmp, name);
    if (!existsSync(join(home, "keep"))) continue;
    const state = readReuseState(home);
    if (state) out.push({ home, state, daemonAlive: await alive(state, home) });
  }
  return out;
}

/**
 * The note to print when the built app is older than the Swift it was built from, or null. Compares
 * mtimes (not hashes): the app has to be cheap to check on every --reuse. `sources` are directories
 * (ios/Harness, ios/HarnessKit/Sources); only `.swift` files count.
 */
export function staleAppNote(appDir: string, sources: readonly string[]): string | null {
  if (!existsSync(appDir)) return null;
  const built = statSync(appDir).mtimeMs;
  let newest: { file: string; mtime: number } | null = null;
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".swift") && st.mtimeMs > built && (!newest || st.mtimeMs > newest.mtime)) newest = { file: full, mtime: st.mtimeMs };
    }
  };
  for (const d of sources) walk(d);
  if (!newest) return null;
  return `the built app predates ${(newest as { file: string }).file} and other Swift changes may be missing from it; add --rebuild to build the current sources`;
}

/** Takes the exclusive lock on a kept home, or says who holds it. */
export function claimKept(name: string, lock: (name: string) => boolean, holder: (name: string) => { pid: number; command: string } | null): string | null {
  if (lock(name)) return null;
  const h = holder(name);
  return `another --reuse run holds ${name}${h ? ` (pid ${h.pid}: ${h.command})` : ""}; wait for it to finish, or run without --reuse to get a daemon of your own`;
}
