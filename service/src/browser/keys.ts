// Map DOM KeyboardEvent `key`/`code` values to the extra fields Input.dispatchKeyEvent needs.
// Chrome only performs editing actions (Backspace, arrows, Enter, Tab…) when
// windowsVirtualKeyCode is set, and on macOS shortcut editing (Cmd+A, Cmd+C…) additionally
// needs explicit `commands`.
//
// Never send nativeVirtualKeyCode. On macOS Chrome builds an NSEvent from it, and any key the
// page leaves unhandled (Shift, Meta, Escape, F-keys…) is redispatched to the window, back to
// the page, and around again forever: 100% CPU and every later CDP command stalls (HARNESS-190).

export const MOD_ALT = 1;
export const MOD_CTRL = 2;
export const MOD_META = 4;
export const MOD_SHIFT = 8;

const NAMED: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  NumpadEnter: 13,
  Shift: 16,
  ShiftLeft: 16,
  ShiftRight: 16,
  Control: 17,
  ControlLeft: 17,
  ControlRight: 17,
  Alt: 18,
  AltLeft: 18,
  AltRight: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  Space: 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  MetaLeft: 91,
  OSLeft: 91,
  MetaRight: 93,
  OSRight: 93,
  ContextMenu: 93,
  Semicolon: 186,
  Equal: 187,
  Comma: 188,
  Minus: 189,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  Backslash: 220,
  BracketRight: 221,
  Quote: 222,
  NumpadMultiply: 106,
  NumpadAdd: 107,
  NumpadSubtract: 109,
  NumpadDecimal: 110,
  NumpadDivide: 111,
};

/** Windows virtual key code for a key event, or 0 when unknown. */
export function virtualKeyCode(key: string, code: string): number {
  if (code in NAMED) return NAMED[code]!;
  if (key in NAMED) return NAMED[key]!;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!.charCodeAt(0);
  m = /^Digit([0-9])$/.exec(code);
  if (m) return 48 + Number(m[1]);
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return 96 + Number(m[1]);
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code || key);
  if (m) return 111 + Number(m[1]);
  if (key.length === 1) {
    const c = key.toUpperCase();
    if (c >= "A" && c <= "Z") return c.charCodeAt(0);
    if (c >= "0" && c <= "9") return c.charCodeAt(0);
  }
  return 0;
}

/** A key browser_keys sends: its DOM key and code, the modifiers held, and the text it types. */
export interface KeyPress {
  key: string;
  code: string;
  modifiers: number;
  /** What it types (absent for Tab, arrows, shortcuts…). */
  text?: string;
}

const MODIFIER_NAMES: Record<string, number> = {
  shift: MOD_SHIFT,
  control: MOD_CTRL,
  ctrl: MOD_CTRL,
  alt: MOD_ALT,
  option: MOD_ALT,
  meta: MOD_META,
  cmd: MOD_META,
  command: MOD_META,
};

/** Named keys browser_keys knows, by their DOM `key` (case-insensitive); each one's `code` is the same name. */
const KEY_NAMES = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
];
const KEY_ALIASES: Record<string, string> = { esc: "Escape", return: "Enter", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };

/** The DOM `code` a single character's key has on a US keyboard, or "" for one without its own key. */
export function charCode(ch: string): string {
  if (/^[a-z]$/i.test(ch)) return `Key${ch.toUpperCase()}`;
  if (/^[0-9]$/.test(ch)) return `Digit${ch}`;
  if (ch === " ") return "Space";
  return "";
}

/** One character typed as a key press (browser_keys per_key): Shift for capitals, Enter for a newline. */
export function charPress(ch: string): KeyPress {
  if (ch === "\n" || ch === "\r") return { key: "Enter", code: "Enter", modifiers: 0, text: "\r" };
  if (ch === "\t") return { key: "Tab", code: "Tab", modifiers: 0 };
  return { key: ch, code: charCode(ch), modifiers: /^[A-Z]$/.test(ch) ? MOD_SHIFT : 0, text: ch };
}

/**
 * A key chord as written for browser_keys: "Tab", "Shift+Tab", "Meta+a", "Control+Shift+ArrowLeft",
 * "Space", "a". Throws, naming the keys it knows, for anything else.
 */
export function parseKeyChord(spec: string): KeyPress {
  const parts = spec.split("+");
  // "+" itself, or a chord ending in it ("Shift++").
  if (spec.endsWith("++") || spec === "+") parts.splice(parts.length - 2, 2, "+");
  let modifiers = 0;
  for (const m of parts.slice(0, -1)) {
    const bit = MODIFIER_NAMES[m.trim().toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${m}" in "${spec}": use Shift, Control, Alt or Meta.`);
    modifiers |= bit;
  }
  const raw = parts[parts.length - 1]!;
  const name = raw.length === 1 ? raw : raw.trim();
  const shortcut = (modifiers & (MOD_CTRL | MOD_META)) !== 0;
  if (name.length === 1) {
    const ch = modifiers & MOD_SHIFT && /^[a-z]$/.test(name) ? name.toUpperCase() : name;
    return { key: ch, code: charCode(name), modifiers, ...(shortcut ? {} : { text: ch }) };
  }
  if (name.toLowerCase() === "space") return { key: " ", code: "Space", modifiers, ...(shortcut ? {} : { text: " " }) };
  const known = KEY_NAMES.find((k) => k.toLowerCase() === name.toLowerCase()) ?? KEY_ALIASES[name.toLowerCase()];
  if (!known) throw new Error(`Unknown key "${name}" in "${spec}". Keys: a single character, Space, ${KEY_NAMES.slice(0, 14).join(", ")}, F1–F12.`);
  return { key: known, code: known, modifiers, ...(known === "Enter" && !shortcut ? { text: "\r" } : {}) };
}

const MAC_COMMANDS: Record<string, string> = {
  KeyA: "selectAll",
  KeyC: "copy",
  KeyX: "cut",
  KeyV: "paste",
  KeyZ: "undo",
};

/** macOS editing commands for Cmd-shortcuts (headless Chrome won't map them itself). */
export function macEditingCommands(code: string, modifiers: number): string[] | undefined {
  if (process.platform !== "darwin") return undefined;
  if (!(modifiers & MOD_META)) return undefined;
  if (code === "KeyZ" && modifiers & MOD_SHIFT) return ["redo"];
  const cmd = MAC_COMMANDS[code];
  return cmd ? [cmd] : undefined;
}
