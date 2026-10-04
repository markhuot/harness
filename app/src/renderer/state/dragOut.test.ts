import { describe, expect, test } from "bun:test";
import { dragOutPoint } from "./dragOut";

const win = { x: 100, y: 50, width: 800, height: 600 };

describe("dragOutPoint", () => {
  test("a drag nobody took, released outside the window, pops out where it was released", () => {
    expect(dragOutPoint({ dropEffect: "none", screenX: 950, screenY: 300 }, win)).toEqual({ x: 950, y: 300 });
    expect(dragOutPoint({ dropEffect: "none", screenX: 99, screenY: 300 }, win)).toEqual({ x: 99, y: 300 });
    expect(dragOutPoint({ dropEffect: "none", screenX: 400, screenY: 49 }, win)).toEqual({ x: 400, y: 49 });
    // The far edges are outside (the window spans x..x+width-1).
    expect(dragOutPoint({ dropEffect: "none", screenX: 900, screenY: 300 }, win)).toEqual({ x: 900, y: 300 });
    expect(dragOutPoint({ dropEffect: "none", screenX: 400.6, screenY: 650 }, win)).toEqual({ x: 401, y: 650 });
  });

  test("inside the window (Escape, or a release where nothing takes it) doesn't", () => {
    expect(dragOutPoint({ dropEffect: "none", screenX: 100, screenY: 50 }, win)).toBeNull();
    expect(dragOutPoint({ dropEffect: "none", screenX: 899, screenY: 649 }, win)).toBeNull();
    expect(dragOutPoint({ dropEffect: "none", screenX: 500, screenY: 300 }, win)).toBeNull();
  });

  test("a drag that was dropped doesn't, wherever it ended", () => {
    expect(dragOutPoint({ dropEffect: "move", screenX: 2000, screenY: 2000 }, win)).toBeNull();
    expect(dragOutPoint({ dropEffect: "copy", screenX: 2000, screenY: 2000 }, win)).toBeNull();
  });

  test("an unknown pointer position doesn't", () => {
    expect(dragOutPoint({ dropEffect: "none", screenX: 0, screenY: 0 }, win)).toBeNull();
    expect(dragOutPoint({ dropEffect: "none", screenX: NaN, screenY: 10 }, win)).toBeNull();
  });
});
