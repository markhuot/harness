import { describe, expect, test } from "bun:test";
import { caretAnchor } from "./caretRect";

const field = { left: 10, right: 410, top: 100, bottom: 600 };

describe("caretAnchor", () => {
  test("the caret's line, at the field's width", () => {
    expect(caretAnchor(field, { top: 48, height: 20 }, 0)).toEqual({ left: 10, right: 410, top: 148, bottom: 168 });
  });

  test("the field's scroll moves the line up", () => {
    expect(caretAnchor(field, { top: 348, height: 20 }, 300)).toEqual({ left: 10, right: 410, top: 148, bottom: 168 });
  });

  test("a line scrolled out of view stays at the field's edge", () => {
    expect(caretAnchor(field, { top: 10, height: 20 }, 200).top).toBe(100);
    expect(caretAnchor(field, { top: 900, height: 20 }, 0)).toEqual({ left: 10, right: 410, top: 580, bottom: 600 });
  });

  test("a field shorter than a line anchors to the whole field", () => {
    expect(caretAnchor({ left: 0, right: 100, top: 50, bottom: 60 }, { top: 0, height: 20 }, 0)).toEqual({ left: 0, right: 100, top: 50, bottom: 60 });
  });
});
