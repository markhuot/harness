import { describe, expect, test } from "bun:test";
import { AwayState, type IdleState, type PowerMonitorLike } from "./awayState";

function setup() {
  const handlers = new Map<string, () => void>();
  const monitor = {
    idle: "active" as IdleState,
    throws: false,
    on: (e: string, fn: () => void) => void handlers.set(e, fn),
    removeListener: (e: string) => void handlers.delete(e),
    getSystemIdleState(_s: number) {
      if (monitor.throws) throw new Error("no idle state");
      return monitor.idle;
    },
  };
  const changes: boolean[] = [];
  let tick: (() => void) | null = null;
  const away = new AwayState({
    monitor: monitor as PowerMonitorLike,
    onChange: (a) => changes.push(a),
    setInterval: (fn) => ((tick = fn), 1),
    clearInterval: () => (tick = null),
  });
  away.start();
  return { away, monitor, handlers, changes, fire: (e: string) => handlers.get(e)!(), tick: () => tick!() };
}

describe("AwayState", () => {
  test("starts present when the system is active", () => {
    const h = setup();
    expect(h.away.away).toBe(false);
    expect(h.changes).toEqual([]);
  });

  test("lock and unlock", () => {
    const h = setup();
    h.fire("lock-screen");
    expect(h.away.away).toBe(true);
    h.fire("unlock-screen");
    expect(h.away.away).toBe(false);
    expect(h.changes).toEqual([true, false]);
  });

  test("suspend and resume", () => {
    const h = setup();
    h.fire("suspend");
    expect(h.away.away).toBe(true);
    h.fire("resume");
    expect(h.away.away).toBe(false);
  });

  test("an idle poll makes the person away and activity brings them back", () => {
    const h = setup();
    h.monitor.idle = "idle";
    h.tick();
    expect(h.away.away).toBe(true);
    h.monitor.idle = "active";
    h.tick();
    expect(h.away.away).toBe(false);
    expect(h.changes).toEqual([true, false]);
  });

  test("away at launch when the system is already idle", () => {
    const h = setup();
    h.away.stop();
    const again = new AwayState({ monitor: { ...h.monitor, getSystemIdleState: () => "idle" } as PowerMonitorLike, onChange: () => {}, setInterval: () => 1, clearInterval: () => {} });
    again.start();
    expect(again.away).toBe(true);
  });

  test("an unknown or failing poll leaves the state alone", () => {
    const h = setup();
    h.monitor.idle = "idle";
    h.tick();
    h.monitor.idle = "unknown";
    h.tick();
    expect(h.away.away).toBe(true);
    h.monitor.throws = true;
    h.tick();
    expect(h.away.away).toBe(true);
    h.monitor.throws = false;
    h.monitor.idle = "active";
    h.fire("unlock-screen");
    h.tick();
    h.monitor.throws = true;
    h.tick();
    expect(h.away.away).toBe(false);
  });

  test("still away while another reason holds after one clears", () => {
    const h = setup();
    h.fire("lock-screen");
    h.monitor.idle = "idle";
    h.tick();
    h.fire("unlock-screen"); // clears lock and idle
    expect(h.away.away).toBe(false);
    h.fire("suspend");
    h.monitor.idle = "active";
    h.tick();
    expect(h.away.away).toBe(true); // asleep until resume, whatever the idle poll says
    expect(h.changes).toEqual([true, false, true]);
  });

  test("a locked poll counts as away; stop detaches the listeners", () => {
    const h = setup();
    h.monitor.idle = "locked";
    h.tick();
    expect(h.away.away).toBe(true);
    h.away.stop();
    expect(h.handlers.size).toBe(0);
  });
});
