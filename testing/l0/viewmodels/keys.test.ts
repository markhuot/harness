import { describe, expect, test } from "bun:test";
import {
  accelerator, chordMatches, COMMAND_BY_ID, COMMANDS, commandAccelerator, commandKeys, formatChord, isAppChord, matchCommands, type Chord, type KeyContext, type KeyEventLike,
} from "../../../app/src/renderer/state/keys";

const ev = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}): KeyEventLike => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const ctx = (o: Partial<KeyContext> = {}): KeyContext => ({ inText: false, inCapture: false, overlay: false, onControl: false, ...o });

describe("registry integrity", () => {
  test("command ids are unique", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test("Actions never get a bare key (they change things)", () => {
    for (const c of COMMANDS.filter((c) => c.group === "Actions")) expect(c.keys).toEqual([]);
  });
  test("within one scope no chord is claimed by two commands", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS) {
      for (const k of c.keys) {
        const id = `${c.scope}|${formatChord(k)}|${k.code}`;
        expect(seen.get(id), `${c.id} vs ${seen.get(id)}`).toBeUndefined();
        seen.set(id, c.id);
      }
    }
  });
  test("menu commands all have a ⌘ chord to build an accelerator from", () => {
    for (const c of COMMANDS.filter((c) => c.menu)) expect(commandAccelerator(c.id), c.id).toBeDefined();
  });
});

describe("chordMatches", () => {
  test("modifiers must match exactly in both directions", () => {
    const cmdK: Chord = { code: "KeyK", meta: true };
    expect(chordMatches(cmdK, ev("KeyK", { metaKey: true }))).toBe(true);
    expect(chordMatches(cmdK, ev("KeyK"))).toBe(false);
    expect(chordMatches(cmdK, ev("KeyK", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(chordMatches({ code: "KeyK" }, ev("KeyK", { metaKey: true }))).toBe(false);
  });
  test("numpad Enter is Enter", () => {
    expect(chordMatches({ code: "Enter" }, ev("NumpadEnter"))).toBe(true);
  });
  test("a different physical key doesn't match", () => {
    expect(chordMatches({ code: "KeyK" }, ev("KeyJ"))).toBe(false);
  });
});

describe("matchCommands", () => {
  const ids = (e: KeyEventLike, scope: Parameters<typeof matchCommands>[1], c = ctx()) => matchCommands(e, scope, c).map((x) => x.id);

  test("a movement key fires in its scope only", () => {
    expect(ids(ev("KeyJ"), "board")).toEqual(["board.down"]);
    expect(ids(ev("KeyJ"), "list")).toEqual(["list.next"]);
    expect(ids(ev("KeyJ"), "global")).toEqual([]);
  });
  test("movement keys are swallowed by text fields, capture surfaces and overlays", () => {
    expect(ids(ev("KeyJ"), "board", ctx({ inText: true }))).toEqual([]);
    expect(ids(ev("KeyJ"), "board", ctx({ inCapture: true }))).toEqual([]);
    expect(ids(ev("KeyJ"), "board", ctx({ overlay: true }))).toEqual([]);
  });
  test("⌘ chords fire in text fields and capture surfaces, but not in an overlay unless inOverlay", () => {
    expect(ids(ev("KeyN", { metaKey: true }), "global", ctx({ inText: true }))).toEqual(["new-session"]);
    expect(ids(ev("KeyN", { metaKey: true }), "global", ctx({ inCapture: true }))).toEqual(["new-session"]);
    expect(ids(ev("KeyN", { metaKey: true }), "global", ctx({ overlay: true }))).toEqual([]);
    expect(ids(ev("KeyK", { metaKey: true }), "global", ctx({ overlay: true }))).toEqual(["palette"]);
  });
  test("notOnControl commands (Space) yield to a focused control, others don't", () => {
    expect(ids(ev("Space"), "ticket")).toEqual(["ticket.pageDown"]);
    expect(ids(ev("Space"), "ticket", ctx({ onControl: true }))).toEqual([]);
    expect(ids(ev("KeyJ"), "ticket", ctx({ onControl: true }))).toEqual(["ticket.scrollDown"]);
  });
  test("shift distinguishes g from G and Space from Shift+Space", () => {
    expect(ids(ev("KeyG"), "board")).toEqual(["board.first"]);
    expect(ids(ev("KeyG", { shiftKey: true }), "board")).toEqual(["board.last"]);
    expect(ids(ev("Space", { shiftKey: true }), "ticket")).toEqual(["ticket.pageUp"]);
  });
  test("⇧⌘↩ is claimed by both pane.zoom (global) and board.openSplit (board), each in its own scope", () => {
    const e = ev("Enter", { metaKey: true, shiftKey: true });
    expect(ids(e, "board")).toEqual(["board.openSplit"]);
    expect(ids(e, "global")).toEqual(["pane.zoom"]);
  });
  test("an alternate chord of the same command matches (ctrl+h as well as ⌥⌘←)", () => {
    expect(ids(ev("KeyH", { ctrlKey: true }), "global")).toEqual(["pane.left"]);
    expect(ids(ev("ArrowLeft", { metaKey: true, altKey: true }), "global")).toEqual(["pane.left"]);
  });
  test("a ctrl chord is movement-tier: it doesn't fire in text fields", () => {
    expect(ids(ev("KeyH", { ctrlKey: true }), "global", ctx({ inText: true }))).toEqual([]);
  });
});

describe("formatChord", () => {
  test("modifier order is ⌃⌥⇧⌘", () => {
    expect(formatChord({ code: "KeyS", meta: true, ctrl: true })).toBe("⌃⌘S");
    expect(formatChord({ code: "ArrowLeft", meta: true, alt: true })).toBe("⌥⌘←");
    expect(formatChord({ code: "BracketRight", meta: true, shift: true })).toBe("⇧⌘]");
  });
  test("a bare letter is lowercase; a shifted bare letter is the typed capital with no ⇧", () => {
    expect(formatChord({ code: "KeyG" })).toBe("g");
    expect(formatChord({ code: "KeyG", shift: true })).toBe("G");
  });
  test("shift+slash is ?; ⌘/ is plain slash; ctrl letters are uppercase", () => {
    expect(formatChord({ code: "Slash", shift: true })).toBe("?");
    expect(formatChord({ code: "Slash", meta: true })).toBe("⌘/");
    expect(formatChord({ code: "KeyH", ctrl: true })).toBe("⌃H");
  });
  test("digits, named keys and unknown codes", () => {
    expect(formatChord({ code: "Digit1", meta: true })).toBe("⌘1");
    expect(formatChord({ code: "Enter" })).toBe("↩");
    expect(formatChord({ code: "Escape" })).toBe("Esc");
    expect(formatChord({ code: "F5" })).toBe("F5");
  });
  test("shift with a non-letter, non-slash key keeps the ⇧", () => {
    expect(formatChord({ code: "Space", shift: true })).toBe("⇧Space");
  });
});

describe("accelerator", () => {
  test("a chord without ⌘ has none", () => {
    expect(accelerator({ code: "KeyH", ctrl: true })).toBeNull();
    expect(accelerator({ code: "KeyG" })).toBeNull();
  });
  test("⌘ chords: ctrl before Cmd, alt after, letters and digits stripped of their prefix", () => {
    expect(accelerator({ code: "KeyK", meta: true })).toBe("Cmd+K");
    expect(accelerator({ code: "KeyS", meta: true, ctrl: true })).toBe("Ctrl+Cmd+S");
    expect(accelerator({ code: "ArrowLeft", meta: true, alt: true })).toBe("Cmd+Alt+Left");
    expect(accelerator({ code: "Digit1", meta: true })).toBe("Cmd+1");
    expect(accelerator({ code: "Comma", meta: true })).toBe("Cmd+,");
  });
  test("shifted punctuation becomes its character, others keep Shift", () => {
    expect(accelerator({ code: "BracketRight", meta: true, shift: true })).toBe("Cmd+}");
    expect(accelerator({ code: "BracketLeft", meta: true, shift: true })).toBe("Cmd+{");
    expect(accelerator({ code: "Enter", meta: true, shift: true })).toBe("Cmd+Shift+Return");
    expect(accelerator({ code: "KeyO", meta: true, shift: true })).toBe("Cmd+Shift+O");
  });
  test("commandAccelerator takes the first ⌘ chord, skipping ones before it; none for a bare-key command", () => {
    expect(commandAccelerator("pane.left")).toBe("Cmd+Alt+Left");
    expect(commandAccelerator("shortcuts")).toBe("Cmd+/");
    expect(commandAccelerator("ticket.compose")).toBeUndefined();
    expect(commandAccelerator("nope")).toBeUndefined();
  });
});

describe("commandKeys", () => {
  test("lists ⌘ chords before the others", () => {
    expect(commandKeys("pane.left")).toEqual(["⌥⌘←", "⌃H"]);
    expect(commandKeys("shortcuts")).toEqual(["⌘/", "?"]);
  });
  test("an unknown or keyless command is empty", () => {
    expect(commandKeys("nope")).toEqual([]);
    expect(commandKeys("board.children")).toEqual([]);
  });
});

describe("isAppChord", () => {
  test("true for a registered ⌘ chord in any scope; false for bare keys and unregistered ⌘ chords", () => {
    expect(isAppChord(ev("KeyK", { metaKey: true }))).toBe(true);
    expect(isAppChord(ev("BracketRight", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isAppChord(ev("KeyJ"))).toBe(false);
    expect(isAppChord(ev("KeyH", { ctrlKey: true }))).toBe(false);
    expect(isAppChord(ev("KeyQ", { metaKey: true }))).toBe(false);
  });
});

test("COMMAND_BY_ID indexes every command", () => {
  expect(COMMAND_BY_ID.size).toBe(COMMANDS.length);
});
