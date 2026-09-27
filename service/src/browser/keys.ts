// Map DOM KeyboardEvent `key`/`code` values to the extra fields Input.dispatchKeyEvent needs.
// Chrome only performs editing actions (Backspace, arrows, Enter, Tab…) when
// windowsVirtualKeyCode is set, and on macOS shortcut editing (Cmd+A, Cmd+C…) additionally
// needs explicit `commands`.

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
