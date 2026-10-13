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
export const REUSE_VERSION = 1;

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
}

export interface Want {
  modeKey: string;
  seeds: readonly string[];
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
 * shared simulator wiped the marker (it uninstalls first), so a changed marker means the app is theirs.
 * Otherwise it's installed (and paired) again, against the same daemon.
 */
export function planApp(
  state: Pick<ReuseState, "udids" | "appHash">,
  now: { udids: readonly string[]; appHash: string; home: string; markers: readonly (string | null)[] },
): AppPlan {
  if (state.appHash !== now.appHash) return { install: true, reason: "the built app changed" };
  if (state.udids.length !== now.udids.length || state.udids.some((u, i) => u !== now.udids[i])) return { install: true, reason: "the simulators differ from the kept run's" };
  if (now.markers.some((m) => m !== now.home)) return { install: true, reason: "the app on the simulator isn't the one paired for this daemon (another run installed over it)" };
  return { install: false };
}

/**
 * A hash of the built app: every file's relative path and bytes, in a fixed order. Content, not
 * mtimes, since a rebuild that changes nothing rewrites every timestamp.
 */
export function hashApp(dir: string): string {
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
