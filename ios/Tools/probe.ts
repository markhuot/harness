// The debug state probe, read side. The app (Harness/App/DebugProbe.swift, only in a SIM_CHECK or
// DEBUG build) writes HarnessKit's DebugState as JSON to <app container>/tmp/harness-debug-state.json
// every ~50 ms; sim-check reads that file instead of asking the accessibility tree, and waits on its
// `settled` instead of sleeping. The shape is documented in ios/ARCHITECTURE.md ("Debug state probe")
// and pinned by ios/HarnessKit/Tests/.../DebugStateTests.swift.

export interface DebugState {
  version: number;
  /** Counts the app's writes: a reader waits for it to move to know the state is fresh. */
  seq: number;
  settled: boolean;
  /** How long the state has stayed the same. */
  quietMs: number;
  busy: string[];
  router: {
    selectedTab: string;
    path: string[];
    sheet: string | null;
    cover: string | null;
    ticketSheet: "presented" | "docked" | "gone";
    dock: { id: number; kind: "ticket" | "newSession" | "file"; title: string; path: string[] }[];
  };
  editor?: {
    markedLines: string[];
    selection: { anchor: number; head: number };
    dirty: boolean;
    scrollY: number;
    lineCount: number;
  };
}

export const PROBE_FILE = "harness-debug-state.json";
const VERSION = 1;

/** Parses the probe file; null for anything that isn't a current-version state (a half-written file can't occur: the app writes atomically). */
export function parseState(text: string): DebugState | null {
  try {
    const s = JSON.parse(text) as DebugState;
    if (s?.version !== VERSION || typeof s.seq !== "number" || typeof s.settled !== "boolean" || !s.router) return null;
    return s;
  } catch {
    return null;
  }
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<unknown>;
}
const realClock: Clock = { now: Date.now, sleep: (ms) => Bun.sleep(ms) };

/** Polls the probe every `every` ms until `pred` accepts a state; throws `timed out: <label>` after `ms`. */
export async function waitFor(
  label: string,
  read: () => Promise<DebugState | null>,
  pred: (s: DebugState) => boolean,
  { ms = 10000, every = 50, clock = realClock }: { ms?: number; every?: number; clock?: Clock } = {},
): Promise<DebugState> {
  const end = clock.now() + ms;
  let last: DebugState | null = null;
  while (clock.now() < end) {
    last = await read();
    if (last && pred(last)) return last;
    await clock.sleep(every);
  }
  throw new Error(`timed out: ${label}${last ? ` (busy: [${last.busy}], quiet ${last.quietMs} ms)` : " (the probe isn't answering)"}`);
}

/**
 * Waits for the app to be at rest: settled, quiet for `quietMs`, and `fresh` writes seen after the
 * call began, so a state that predates the action that came just before can't pass (the count is of
 * seq changes, not its value: a relaunched app starts over from 1). Null when the probe never
 * answers within `probeMs` (an app without it): the caller can stop asking. "frozen" when it answers
 * but doesn't change within `probeMs` (a stale file from an earlier launch, a crashed or stalled
 * app): that may pass, so the caller falls back to a fixed wait this once and asks again later.
 */
export async function settled(
  read: () => Promise<DebugState | null>,
  { quietMs = 0, fresh = 3, ms = 10000, probeMs = 600, every = 50, clock = realClock }: { quietMs?: number; fresh?: number; ms?: number; probeMs?: number; every?: number; clock?: Clock } = {},
): Promise<DebugState | "frozen" | null> {
  // A probe file left from an earlier launch (or an app that crashed) answers too, but it never
  // changes: only a seq change within probeMs shows the app is writing it now.
  // The first read retries for probeMs too: an app just (re)launched hasn't written its file yet.
  const first = await waitFor("the probe to answer", read, () => true, { ms: probeMs, every, clock }).catch(() => null);
  if (!first) return null;
  const live = await waitFor("the probe to change", read, (s) => s.seq !== first.seq, { ms: probeMs, every, clock }).catch(() => null);
  if (!live) return "frozen";
  let prev = live.seq;
  let writes = 1;
  return waitFor(
    "the app to settle",
    read,
    (s) => {
      if (s.seq !== prev) {
        prev = s.seq;
        writes++;
      }
      return writes >= fresh && s.settled && s.quietMs >= quietMs;
    },
    { ms, every, clock },
  );
}
