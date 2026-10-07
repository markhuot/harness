import { describe, expect, test } from "bun:test";
import { MOD_ALT, MOD_CTRL, MOD_META, MOD_SHIFT, charPress, parseKeyChord } from "./keys.ts";

describe("parseKeyChord", () => {
  test("named keys keep their name as code; only Enter types something", () => {
    expect(parseKeyChord("Tab")).toEqual({ key: "Tab", code: "Tab", modifiers: 0 });
    expect(parseKeyChord("enter")).toEqual({ key: "Enter", code: "Enter", modifiers: 0, text: "\r" });
    expect(parseKeyChord("esc")).toEqual({ key: "Escape", code: "Escape", modifiers: 0 });
    expect(parseKeyChord("down")).toEqual({ key: "ArrowDown", code: "ArrowDown", modifiers: 0 });
    expect(parseKeyChord("F12")).toEqual({ key: "F12", code: "F12", modifiers: 0 });
  });

  test("modifiers join with +, in any case and with aliases", () => {
    expect(parseKeyChord("Shift+Tab")).toEqual({ key: "Tab", code: "Tab", modifiers: MOD_SHIFT });
    expect(parseKeyChord("ctrl+alt+Delete").modifiers).toBe(MOD_CTRL | MOD_ALT);
    expect(parseKeyChord("Cmd+Shift+ArrowLeft").modifiers).toBe(MOD_META | MOD_SHIFT);
  });

  test("a character types itself, capitalized with Shift, and not at all in a shortcut", () => {
    expect(parseKeyChord("a")).toEqual({ key: "a", code: "KeyA", modifiers: 0, text: "a" });
    expect(parseKeyChord("Shift+a")).toEqual({ key: "A", code: "KeyA", modifiers: MOD_SHIFT, text: "A" });
    expect(parseKeyChord("Meta+a")).toEqual({ key: "a", code: "KeyA", modifiers: MOD_META });
    expect(parseKeyChord("7")).toEqual({ key: "7", code: "Digit7", modifiers: 0, text: "7" });
    expect(parseKeyChord("Space")).toEqual({ key: " ", code: "Space", modifiers: 0, text: " " });
    expect(parseKeyChord("Control+Enter")).toEqual({ key: "Enter", code: "Enter", modifiers: MOD_CTRL });
  });

  test("+ is a key too, alone or at the end of a chord", () => {
    expect(parseKeyChord("+")).toEqual({ key: "+", code: "", modifiers: 0, text: "+" });
    expect(parseKeyChord("Control++")).toEqual({ key: "+", code: "", modifiers: MOD_CTRL });
  });

  test("an unknown key or modifier is an error that says what's known", () => {
    expect(() => parseKeyChord("Hyper+a")).toThrow('Unknown modifier "Hyper" in "Hyper+a"');
    expect(() => parseKeyChord("Return2")).toThrow('Unknown key "Return2"');
    expect(() => parseKeyChord("Shift+")).toThrow('Unknown key ""');
  });
});

describe("charPress", () => {
  test("capitals hold Shift, a newline is Enter, a tab is Tab without text", () => {
    expect(charPress("Q")).toEqual({ key: "Q", code: "KeyQ", modifiers: MOD_SHIFT, text: "Q" });
    expect(charPress("q")).toEqual({ key: "q", code: "KeyQ", modifiers: 0, text: "q" });
    expect(charPress("\n")).toEqual({ key: "Enter", code: "Enter", modifiers: 0, text: "\r" });
    expect(charPress("\t")).toEqual({ key: "Tab", code: "Tab", modifiers: 0 });
    expect(charPress("/")).toEqual({ key: "/", code: "", modifiers: 0, text: "/" });
  });
});
