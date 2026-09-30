import { describe, expect, test } from "bun:test";
import { accelerator, chordMatches, COMMANDS, commandAccelerator, commandKeys, formatChord, isAppChord, isGlobalChord, matchCommands, type KeyContext, type KeyEventLike } from "./keys";
import { rankCommands } from "./palette";

const ev = (code: string, mods: Partial<Omit<KeyEventLike, "code">> = {}): KeyEventLike => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const free: KeyContext = { inText: false, inCapture: false, overlay: false, onControl: false };
const ids = (e: KeyEventLike, scope: Parameters<typeof matchCommands>[1], ctx: Partial<KeyContext> = {}) => matchCommands(e, scope, { ...free, ...ctx }).map((c) => c.id);

describe("the registry", () => {
  test("no action ever has a bare key: single keys only move you around", () => {
    for (const c of COMMANDS) {
      if (c.group !== "Actions") continue;
      expect(c.keys.filter((k) => !isGlobalChord(k))).toEqual([]);
    }
  });
  test("ticket actions are found by the way people say them, not only by their labels", () => {
    const actions = COMMANDS.filter((c) => c.group === "Actions").map((c) => ({ id: c.id, label: c.label, keywords: c.keywords }));
    const top = (q: string) => rankCommands(q, actions)[0]?.item.id;
    expect(top("reopen ticket")).toBe("ticket.reopen");
    expect(top("rerun agent review")).toBe("ticket.rerunReview");
    expect(top("stop run")).toBe("ticket.cancelRun");
    expect(top("approve and merge")).toBe("ticket.land.merge");
  });
  test("command ids are unique", () => {
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });
  test("no two commands in one scope share a chord (a key would be ambiguous)", () => {
    const seen = new Map<string, string>();
    for (const c of COMMANDS)
      for (const k of c.keys) {
        const sig = `${c.scope}:${k.code}:${!!k.meta}${!!k.ctrl}${!!k.alt}${!!k.shift}`;
        expect(seen.get(sig) ?? c.id).toBe(c.id);
        seen.set(sig, c.id);
      }
  });
  test("every ⌘ chord in the menu bar has an accelerator", () => {
    for (const c of COMMANDS.filter((c) => c.menu)) expect(commandAccelerator(c.id)).toBeTruthy();
  });
});

describe("chordMatches", () => {
  test("⌘⇧] matches by code even though key reports }", () => {
    expect(chordMatches({ code: "BracketRight", meta: true, shift: true }, { ...ev("BracketRight", { metaKey: true, shiftKey: true }) })).toBe(true);
  });
  test("modifiers must match exactly: ⌘⌥← is not ⌘←", () => {
    expect(chordMatches({ code: "ArrowLeft", meta: true, alt: true }, ev("ArrowLeft", { metaKey: true }))).toBe(false);
    expect(chordMatches({ code: "KeyG" }, ev("KeyG", { shiftKey: true }))).toBe(false);
  });
  test("numpad Enter is Enter", () => {
    expect(chordMatches({ code: "Enter" }, ev("NumpadEnter"))).toBe(true);
  });
});

describe("matchCommands (the tiers)", () => {
  test("movement keys act in their own scope only", () => {
    expect(ids(ev("KeyJ"), "board")).toEqual(["board.down"]);
    expect(ids(ev("KeyJ"), "ticket")).toEqual(["ticket.scrollDown"]);
    expect(ids(ev("KeyJ"), "list")).toEqual(["list.next"]);
    expect(ids(ev("KeyJ"), "global")).toEqual([]);
  });
  test("typing in a text field never moves anything", () => {
    for (const code of ["KeyH", "KeyJ", "KeyK", "KeyL", "KeyG", "Enter", "Slash", "KeyI", "Digit1"]) {
      expect(ids(ev(code), "board", { inText: true })).toEqual([]);
      expect(ids(ev(code), "ticket", { inText: true })).toEqual([]);
    }
    expect(ids(ev("Slash", { shiftKey: true }), "global", { inText: true })).toEqual([]); // "?" is typed, not the overlay
    expect(ids(ev("Escape"), "global", { inText: true })).toEqual([]);
    expect(ids(ev("KeyH", { ctrlKey: true }), "global", { inText: true })).toEqual([]); // ⌃H is delete-backward there
  });
  test("⌘ chords work in text fields, the canvas and terminals", () => {
    expect(ids(ev("BracketRight", { metaKey: true, shiftKey: true }), "ticket", { inText: true })).toEqual(["tab.next"]);
    expect(ids(ev("ArrowLeft", { metaKey: true, altKey: true }), "global", { inCapture: true })).toEqual(["pane.left"]);
    expect(ids(ev("KeyW", { metaKey: true }), "global", { inText: true })).toEqual(["pane.close"]);
  });
  test("the canvas and terminals keep every movement key", () => {
    expect(ids(ev("KeyJ"), "ticket", { inCapture: true })).toEqual([]);
    expect(ids(ev("Escape"), "global", { inCapture: true })).toEqual([]);
  });
  test("an open modal, menu or palette blocks everything but toggling the palette and the overlay", () => {
    expect(ids(ev("KeyW", { metaKey: true }), "global", { overlay: true })).toEqual([]);
    expect(ids(ev("Escape"), "global", { overlay: true })).toEqual([]);
    expect(ids(ev("KeyK", { metaKey: true }), "global", { overlay: true })).toEqual(["palette"]);
    expect(ids(ev("Slash", { metaKey: true }), "global", { overlay: true })).toEqual(["shortcuts"]);
  });
  test("Space pages only when it isn't pressing a focused button", () => {
    expect(ids(ev("Space"), "ticket")).toEqual(["ticket.pageDown"]);
    expect(ids(ev("Space"), "ticket", { onControl: true })).toEqual([]);
    // j/k still scroll from a focused tab.
    expect(ids(ev("KeyJ"), "ticket", { onControl: true })).toEqual(["ticket.scrollDown"]);
  });
  test("g and G are different commands; ⌃hjkl moves between panes", () => {
    expect(ids(ev("KeyG"), "board")).toEqual(["board.first"]);
    expect(ids(ev("KeyG", { shiftKey: true }), "board")).toEqual(["board.last"]);
    expect(ids(ev("KeyL", { ctrlKey: true }), "global")).toEqual(["pane.right"]);
  });
});

describe("formatChord / commandKeys", () => {
  test("Mac modifier order, and shifted letters written as typed", () => {
    expect(formatChord({ code: "ArrowLeft", meta: true, alt: true })).toBe("⌥⌘←");
    expect(formatChord({ code: "BracketRight", meta: true, shift: true })).toBe("⇧⌘]");
    expect(formatChord({ code: "KeyS", meta: true, ctrl: true })).toBe("⌃⌘S");
    expect(formatChord({ code: "KeyG", shift: true })).toBe("G");
    expect(formatChord({ code: "KeyG" })).toBe("g");
    expect(formatChord({ code: "Slash", shift: true })).toBe("?");
    expect(formatChord({ code: "Space", shift: true })).toBe("⇧Space");
  });
  test("⌘ chords are listed before movement keys", () => {
    expect(commandKeys("pane.left")).toEqual(["⌥⌘←", "⌃H"]);
  });
});

describe("accelerator", () => {
  test("shifted punctuation becomes its character so macOS matches it", () => {
    expect(accelerator({ code: "BracketRight", meta: true, shift: true })).toBe("Cmd+}");
    expect(accelerator({ code: "BracketLeft", meta: true, shift: true })).toBe("Cmd+{");
  });
  test("other modifiers and keys", () => {
    expect(accelerator({ code: "ArrowLeft", meta: true, alt: true })).toBe("Cmd+Alt+Left");
    expect(accelerator({ code: "KeyS", meta: true, ctrl: true })).toBe("Ctrl+Cmd+S");
    expect(accelerator({ code: "Enter", meta: true, shift: true })).toBe("Cmd+Shift+Return");
    expect(accelerator({ code: "Digit1", meta: true })).toBe("Cmd+1");
  });
  test("Equalize Panes is ⌘= (the key Electron's Zoom In used to take)", () => {
    expect(commandKeys("pane.equalize")).toEqual(["⌘="]);
    expect(commandAccelerator("pane.equalize")).toBe("Cmd+=");
  });
  test("keys without ⌘ are the renderer's, never the menu's", () => {
    expect(accelerator({ code: "KeyH", ctrl: true })).toBeNull();
    expect(commandAccelerator("board.down")).toBeUndefined();
  });
});

describe("isAppChord (what the browser canvas keeps from its page)", () => {
  test("the app's ⌘ chords, whatever scope they act in", () => {
    expect(isAppChord(ev("BracketRight", { metaKey: true, shiftKey: true }))).toBe(true);
    expect(isAppChord(ev("KeyK", { metaKey: true }))).toBe(true);
    expect(isAppChord(ev("ArrowLeft", { metaKey: true, altKey: true }))).toBe(true);
  });
  test("not the page's own keys: plain letters, ⌃ keys, or ⌘ keys the app doesn't use", () => {
    expect(isAppChord(ev("KeyJ"))).toBe(false);
    expect(isAppChord(ev("KeyH", { ctrlKey: true }))).toBe(false);
    expect(isAppChord(ev("KeyL", { metaKey: true }))).toBe(false); // ⌘L is the page's (or nobody's)
    expect(isAppChord(ev("ArrowLeft", { metaKey: true }))).toBe(false); // ⌘← is line start in the page
  });
});
