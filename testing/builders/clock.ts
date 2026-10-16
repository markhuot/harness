import type { Clock } from "../../service/src/clock";

/** A clock that only moves when the test says so. */
export interface FakeClock extends Clock {
  advance(ms: number): void;
  set(at: number): void;
}

export function fakeClock(start = 1_000_000): FakeClock {
  let at = start;
  const clock = (() => at) as FakeClock;
  clock.advance = (ms) => {
    at += ms;
  };
  clock.set = (next) => {
    at = next;
  };
  return clock;
}
