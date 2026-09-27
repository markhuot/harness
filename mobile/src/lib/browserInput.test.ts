import { describe, expect, test } from "bun:test";
import { fitRect, toPagePoint } from "@harness/shared/state";
import { keyPress, ResizeGate, textChangeInputs, textDelta, TouchGesture, type Point } from "./browserInput";

// A 1280×800 page letterboxed into a 400×400 stage → drawn at y 75…325, 0.3125 stage pt per page px.
const page = { width: 1280, height: 800 };
const drawn = fitRect(400, 400, page.width, page.height);
const gesture = (o: Partial<ConstructorParameters<typeof TouchGesture>[0]> = {}) =>
  new TouchGesture({ toPage: (p: Point) => toPagePoint(p, drawn, page), scale: () => page.width / drawn.w, ...o });

describe("TouchGesture", () => {
  test("a tap is move + down + up at the page point", () => {
    const g = gesture();
    expect(g.begin({ x: 200, y: 200 }, 0)).toEqual([]);
    expect(g.move({ x: 203, y: 201 }, 40)).toEqual([]); // within slop: still a tap
    expect(g.end({ x: 203, y: 201 }, 90)).toEqual([
      { type: "mouse", action: "move", x: 650, y: 403 },
      { type: "mouse", action: "down", x: 650, y: 403, button: "left", clickCount: 1 },
      { type: "mouse", action: "up", x: 650, y: 403, button: "left", clickCount: 1 },
    ]);
  });

  test("two quick taps nearby → clickCount 2; a slow or distant second tap is a new click", () => {
    const g = gesture();
    g.begin({ x: 100, y: 100 }, 0);
    g.end({ x: 100, y: 100 }, 50);
    g.begin({ x: 104, y: 102 }, 200);
    expect(g.end({ x: 104, y: 102 }, 250).map((e) => (e as { clickCount?: number }).clickCount)).toEqual([undefined, 2, 2]);
    g.begin({ x: 104, y: 102 }, 2000);
    expect((g.end({ x: 104, y: 102 }, 2050)[1] as { clickCount: number }).clickCount).toBe(1);
    g.begin({ x: 300, y: 300 }, 2100);
    expect((g.end({ x: 300, y: 300 }, 2150)[1] as { clickCount: number }).clickCount).toBe(1);
  });

  test("taps in the letterbox bars do nothing", () => {
    const g = gesture();
    g.begin({ x: 200, y: 20 }, 0);
    expect(g.end({ x: 200, y: 20 }, 30)).toEqual([]);
  });

  test("a pan scrolls: finger up → positive deltaY, in page pixels", () => {
    const g = gesture();
    g.begin({ x: 200, y: 300 }, 0);
    const first = g.move({ x: 200, y: 280 }, 30);
    expect(g.state).toBe("pan");
    expect(first).toEqual([{ type: "mouse", action: "wheel", x: 640, y: 656, deltaX: 0, deltaY: 64 }]);
    // Horizontal drag right → negative deltaX (content moves with the finger)
    expect(g.move({ x: 210, y: 280 }, 60)).toEqual([{ type: "mouse", action: "wheel", x: 672, y: 656, deltaX: -32, deltaY: 0 }]);
    expect(g.end({ x: 210, y: 280 }, 90)).toEqual([]); // no click after a pan
  });

  test("a pan that leaves the frame keeps scrolling at the last page point", () => {
    const g = gesture();
    g.begin({ x: 200, y: 100 }, 0);
    g.move({ x: 200, y: 90 }, 20);
    const out = g.move({ x: 200, y: 40 }, 40); // above the drawn frame now
    expect(out).toEqual([{ type: "mouse", action: "wheel", x: 640, y: 48, deltaX: 0, deltaY: 160 }]);
  });

  test("hold then move drags: down at the start, moves, up at the end", () => {
    const g = gesture();
    g.begin({ x: 100, y: 200 }, 0);
    expect(g.move({ x: 101, y: 200 }, 500)).toEqual([]); // still inside slop
    const started = g.move({ x: 130, y: 200 }, 600);
    expect(g.state).toBe("drag");
    expect(started).toEqual([
      { type: "mouse", action: "move", x: 320, y: 400 },
      { type: "mouse", action: "down", x: 320, y: 400, button: "left", clickCount: 1 },
      { type: "mouse", action: "move", x: 416, y: 400 },
    ]);
    expect(g.end({ x: 150, y: 200 }, 700)).toEqual([{ type: "mouse", action: "up", x: 480, y: 400, button: "left", clickCount: 1 }]);
  });

  test("cancel mid-drag releases the button; cancel mid-pan sends nothing", () => {
    const g = gesture();
    g.begin({ x: 100, y: 200 }, 0);
    g.move({ x: 130, y: 200 }, 600);
    expect(g.cancel()).toEqual([{ type: "mouse", action: "up", x: 416, y: 400, button: "left", clickCount: 1 }]);
    g.begin({ x: 100, y: 200 }, 1000);
    g.move({ x: 100, y: 150 }, 1010);
    expect(g.cancel()).toEqual([]);
    expect(g.move({ x: 1, y: 1 }, 1020)).toEqual([]); // idle after cancel
  });
});

describe("keyboard", () => {
  test("textDelta: typing, deleting and autocorrect replacements", () => {
    expect(textDelta("", "a")).toEqual({ deletes: 0, insert: "a" });
    expect(textDelta("hel", "hello")).toEqual({ deletes: 0, insert: "lo" });
    expect(textDelta("hello", "hel")).toEqual({ deletes: 2, insert: "" });
    expect(textDelta("teh", "the")).toEqual({ deletes: 2, insert: "he" });
    expect(textDelta("x", "x")).toEqual({ deletes: 0, insert: "" });
  });

  test("changes become Backspace presses and one text insert", () => {
    expect(textChangeInputs("teh", "the ")).toEqual([
      { type: "key", action: "down", key: "Backspace", code: "Backspace" },
      { type: "key", action: "up", key: "Backspace", code: "Backspace" },
      { type: "key", action: "down", key: "Backspace", code: "Backspace" },
      { type: "key", action: "up", key: "Backspace", code: "Backspace" },
      { type: "text", text: "he " },
    ]);
    expect(textChangeInputs("a", "a")).toEqual([]);
  });

  test("named keys press and release; printable keys are left to text input", () => {
    expect(keyPress("Enter")).toEqual([
      { type: "key", action: "down", key: "Enter", code: "Enter" },
      { type: "key", action: "up", key: "Enter", code: "Enter" },
    ]);
    expect(keyPress("a")).toEqual([]);
    expect(keyPress(" ")).toEqual([]);
  });
});

test("ResizeGate: nothing before the subscription is confirmed, then only real changes", () => {
  const g = new ResizeGate();
  expect(g.take(390, 600)).toBeNull();
  expect(g.confirm()).toBe(true);
  expect(g.confirm()).toBe(false);
  expect(g.take(390.4, 600.2)).toEqual({ type: "resize", width: 390, height: 600 });
  expect(g.take(390, 600)).toBeNull();
  expect(g.take(0, 600)).toBeNull();
  expect(g.take(390, 520)).toEqual({ type: "resize", width: 390, height: 520 });
  g.reset(); // reconnect: the service-side subscription starts over, so resend once confirmed
  expect(g.take(390, 520)).toBeNull();
  g.confirm();
  expect(g.take(390, 520)).toEqual({ type: "resize", width: 390, height: 520 });
});
