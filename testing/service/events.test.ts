import { expect, spyOn, test } from "bun:test";
import type { HarnessEvent } from "@harness/shared";
import { EventBus } from "../../service/src/events";

const ev = (kind: string, extra: object = {}) => ({ kind, ...extra }) as unknown as HarnessEvent;

test("kind listeners only hear their kind; all-listeners hear everything", () => {
  const bus = new EventBus();
  const all: string[] = [];
  const only: string[] = [];
  bus.on((e) => all.push(e.kind));
  bus.onKind("ticket.updated" as never, (e) => only.push(e.kind));
  bus.emit(ev("ticket.updated"));
  bus.emit(ev("run.updated"));
  expect(all).toEqual(["ticket.updated", "run.updated"]);
  expect(only).toEqual(["ticket.updated"]);
});

test("unsubscribing stops delivery and drops the listener count", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const off = bus.on((e) => seen.push(e.kind));
  const offKind = bus.onKind("run.updated" as never, () => seen.push("kind"));
  expect(bus.listenerCount).toBe(2);
  off();
  offKind();
  bus.emit(ev("run.updated"));
  expect(seen).toEqual([]);
  expect(bus.listenerCount).toBe(0);
});

test("a throwing listener is logged and does not stop the others", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on(() => {
      throw new Error("bad listener");
    });
    bus.on((e) => seen.push(e.kind));
    bus.emit(ev("run.updated"));
    expect(seen).toEqual(["run.updated"]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
});

test("a listener that unsubscribes itself mid-emit doesn't skip its neighbour", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const off = bus.on(() => {
    seen.push("first");
    off();
  });
  bus.on(() => seen.push("second"));
  bus.emit(ev("run.updated"));
  bus.emit(ev("run.updated"));
  expect(seen).toEqual(["first", "second", "second"]);
});
