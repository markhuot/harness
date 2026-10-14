import { describe, expect, test } from "bun:test";
import { type Clock, type DebugState, parseState, settled, waitFor } from "./probe";

const state = (o: Partial<DebugState> = {}): DebugState => ({
  version: 1, seq: 1, settled: true, quietMs: 1000, busy: [], dockMounts: 1,
  router: { selectedTab: "board", path: [], sheet: null, cover: null, ticketSheet: "gone", dock: [] },
  ...o,
});

/** A clock that advances 50 ms per sleep, so a script of reads plays out instantly. */
function fake(): Clock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
}
const script = (states: (DebugState | null)[]) => {
  let i = 0;
  return async () => states[Math.min(i++, states.length - 1)]!;
};

describe("parseState", () => {
  test("accepts the current shape and rejects a stale version, junk and missing fields", () => {
    expect(parseState(JSON.stringify(state()))?.router.selectedTab).toBe("board");
    expect(parseState(JSON.stringify({ ...state(), version: 2 }))).toBeNull();
    expect(parseState("{\"version\":1")).toBeNull();
    expect(parseState(JSON.stringify({ version: 1, seq: 1, settled: true }))).toBeNull();
  });
});

describe("settled", () => {
  test("waits out a state that predates the action: it needs fresh writes, not just settled", async () => {
    const clock = fake();
    // seq 5 is settled but old; seq 6-7 are mid-change; seq 8+ is at rest again.
    const read = script([state({ seq: 5 }), state({ seq: 5 }), state({ seq: 6, settled: false, quietMs: 0 }), state({ seq: 7, settled: false, quietMs: 50 }), state({ seq: 8, settled: true, quietMs: 300 })]);
    const s = await settled(read, { clock });
    expect((s as DebugState | null)?.seq).toBe(8);
  });

  test("needs three fresh writes, even settled, and survives the app relaunching (seq starting over)", async () => {
    const clock = fake();
    const s = await settled(script([state({ seq: 900 }), state({ seq: 1 }), state({ seq: 2 }), state({ seq: 3 })]), { clock });
    expect((s as DebugState | null)?.seq).toBe(3);
    expect(clock.t).toBe(50);
  });

  test("honours a longer quiet window than the app's", async () => {
    const clock = fake();
    const s = await settled(script([state({ seq: 1 }), state({ seq: 2, quietMs: 100 }), state({ seq: 3, quietMs: 200 }), state({ seq: 4, quietMs: 300 }), state({ seq: 5, quietMs: 450 })]), { clock, quietMs: 400 });
    expect((s as DebugState | null)?.seq).toBe(5);
  });

  test("busy keeps it waiting, and the timeout says what it was busy with", async () => {
    const clock = fake();
    const busy = state({ seq: 9, settled: false, busy: ["editor"], quietMs: 5000 });
    let n = 0;
    const read = async () => ({ ...busy, seq: busy.seq + n++ });
    await expect(settled(read, { clock, ms: 500 })).rejects.toThrow(/busy: \[editor\]/);
  });

  test("returns null when nothing answers, for the caller to sleep instead", async () => {
    const clock = fake();
    expect(await settled(script([null]), { clock })).toBeNull();
  });

  test("waits for a probe that isn't up yet (just launched) instead of giving up", async () => {
    const clock = fake();
    const read = script([null, null, null, state({ seq: 1 }), state({ seq: 2 }), state({ seq: 3 }), state({ seq: 4 })]);
    const s = await settled(read, { clock });
    expect(s).not.toBeNull();
    expect(s).not.toBe("frozen");
  });

  test("a stale probe file that answers but never changes is \"frozen\" (a one-off wait), not null (probe off), and doesn't time out", async () => {
    const clock = fake();
    // Settled and quiet, but left from an earlier launch: the same seq on every read.
    expect(await settled(script([state({ seq: 40 })]), { clock })).toBe("frozen");
    // It gave up after probeMs, not the full 10 s settle timeout.
    expect(clock.t).toBeLessThanOrEqual(650);
  });
});

describe("waitFor", () => {
  test("polls until the predicate holds", async () => {
    const clock = fake();
    const s = await waitFor("a dock", script([state(), state(), state({ router: { ...state().router, ticketSheet: "docked" } })]), (x) => x.router.ticketSheet === "docked", { clock });
    expect(s.router.ticketSheet).toBe("docked");
    expect(clock.t).toBe(100);
  });

  test("times out with the label", async () => {
    await expect(waitFor("never", script([state()]), () => false, { clock: fake(), ms: 200 })).rejects.toThrow("timed out: never");
  });
});
