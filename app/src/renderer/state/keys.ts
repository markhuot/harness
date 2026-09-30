// The keyboard command registry: every shortcut in the app, as data. The pure helpers here (matching
// a key event to a command, formatting a chord for display or as an Electron accelerator) are
// tested in keys.test.ts; components/commands.tsx wires the registry to handlers and the DOM, and
// the main process builds its menu accelerators from the same list.
//
// Two tiers (DESIGN.md "Keyboard"):
//   • ⌘ chords work everywhere: in text fields, the browser canvas and (through the native menu,
//     which fires whatever frame has focus) plugin iframes and terminals.
//   • Every other key (hjkl, Enter, g/G, /, ?, i, 1–9, ⌃hjkl, Escape) only moves you around. It never
//     changes a ticket, and it only fires outside text fields, the canvas, terminals and overlays.
//
// Each command has a scope: the kind of area it acts on. Areas mark themselves in the DOM with
// data-keys-scope (components/commands.tsx), and a key goes to the innermost area around the focus
// that has a command for it, then outward, ending at "global".

/** The kinds of area a command acts on (see data-keys-scope). */
export type KeyScope = "global" | "board" | "ticket" | "list" | "sidebar";

/** Groups in the shortcuts overlay and the palette. "Actions" change something and never get a bare key. */
export type CommandGroup = "General" | "Panes" | "Board" | "Ticket" | "Lists" | "Actions";

/** A key plus modifiers. `code` is KeyboardEvent.code, so ⌘⇧] matches whatever `key` reports ("}"). */
export interface Chord {
  code: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface CommandSpec {
  id: string;
  label: string;
  group: CommandGroup;
  scope: KeyScope;
  keys: Chord[];
  /** Listed in the palette when a handler is available (default true). */
  palette?: boolean;
  /** Runs while a modal, menu or the palette is open (toggling the palette itself). */
  inOverlay?: boolean;
  /** Also listed in the menu bar; the menu item sends the id back as a MenuCommand. */
  menu?: boolean;
  /** Ignored while focus is on a button, link or other control (Enter/Space belong to the control). */
  notOnControl?: boolean;
}

const k = (code: string, mods: Omit<Chord, "code"> = {}): Chord => ({ code, ...mods });
const cmd = (code: string, mods: Omit<Chord, "code" | "meta"> = {}): Chord => ({ code, meta: true, ...mods });

/** Every command. Ids of the menu bar's commands double as MenuCommand strings (main/types.ts). */
export const COMMANDS: CommandSpec[] = [
  // General (⌘ chords, also in the menu bar)
  { id: "palette", label: "Command Palette…", group: "General", scope: "global", keys: [cmd("KeyK")], inOverlay: true, menu: true, palette: false },
  // The palette in files mode ("@"); inOverlay so ⌘P switches an open palette over to files.
  { id: "open-file", label: "Open File…", group: "General", scope: "global", keys: [cmd("KeyP")], inOverlay: true, menu: true },
  { id: "shortcuts", label: "Keyboard Shortcuts", group: "General", scope: "global", keys: [cmd("Slash"), k("Slash", { shift: true })], inOverlay: true, menu: true },
  { id: "new-session", label: "New Session…", group: "General", scope: "global", keys: [cmd("KeyN")], menu: true },
  { id: "new-terminal", label: "New Terminal", group: "General", scope: "global", keys: [cmd("KeyT")], menu: true },
  { id: "board", label: "Go to Board", group: "General", scope: "global", keys: [cmd("Digit1")], menu: true },
  { id: "inbox", label: "Go to Inbox", group: "General", scope: "global", keys: [cmd("Digit2")], menu: true },
  { id: "settings", label: "Open Settings", group: "General", scope: "global", keys: [cmd("Comma")], menu: true },
  { id: "toggle-sidebar", label: "Toggle Sidebar", group: "General", scope: "global", keys: [cmd("KeyS", { ctrl: true })], menu: true },

  // Panes
  { id: "pane.left", label: "Focus Pane Left", group: "Panes", scope: "global", keys: [cmd("ArrowLeft", { alt: true }), k("KeyH", { ctrl: true })], menu: true },
  { id: "pane.right", label: "Focus Pane Right", group: "Panes", scope: "global", keys: [cmd("ArrowRight", { alt: true }), k("KeyL", { ctrl: true })], menu: true },
  { id: "pane.up", label: "Focus Pane Above", group: "Panes", scope: "global", keys: [cmd("ArrowUp", { alt: true }), k("KeyK", { ctrl: true })], menu: true },
  { id: "pane.down", label: "Focus Pane Below", group: "Panes", scope: "global", keys: [cmd("ArrowDown", { alt: true }), k("KeyJ", { ctrl: true })], menu: true },
  { id: "pane.close", label: "Close Pane", group: "Panes", scope: "global", keys: [cmd("KeyW")], menu: true },
  { id: "pane.zoom", label: "Maximize / Restore Pane", group: "Panes", scope: "global", keys: [cmd("Enter", { shift: true })], menu: true },
  { id: "pane.popout", label: "Pop Out Pane", group: "Panes", scope: "global", keys: [cmd("KeyO", { shift: true })], menu: true },
  { id: "pane.equalize", label: "Equalize Panes", group: "Panes", scope: "global", keys: [cmd("Equal")], menu: true },
  { id: "pane.escape", label: "End zoom, or close the ticket pane", group: "Panes", scope: "global", keys: [k("Escape")], palette: false },

  // Ticket pane
  { id: "tab.next", label: "Next Tab", group: "Ticket", scope: "ticket", keys: [cmd("BracketRight", { shift: true })], menu: true },
  { id: "tab.prev", label: "Previous Tab", group: "Ticket", scope: "ticket", keys: [cmd("BracketLeft", { shift: true })], menu: true },
  ...Array.from({ length: 9 }, (_, i): CommandSpec => ({ id: `tab.${i + 1}`, label: `Tab ${i + 1}`, group: "Ticket", scope: "ticket", keys: [k(`Digit${i + 1}`)], palette: false })),
  { id: "ticket.compose", label: "Write to the agent", group: "Ticket", scope: "ticket", keys: [k("KeyI")] },
  { id: "ticket.scrollDown", label: "Scroll down", group: "Ticket", scope: "ticket", keys: [k("KeyJ"), k("ArrowDown")], palette: false },
  { id: "ticket.scrollUp", label: "Scroll up", group: "Ticket", scope: "ticket", keys: [k("KeyK"), k("ArrowUp")], palette: false },
  { id: "ticket.pageDown", label: "Page down", group: "Ticket", scope: "ticket", keys: [k("Space")], palette: false, notOnControl: true },
  { id: "ticket.pageUp", label: "Page up", group: "Ticket", scope: "ticket", keys: [k("Space", { shift: true })], palette: false, notOnControl: true },
  { id: "ticket.top", label: "Scroll to top", group: "Ticket", scope: "ticket", keys: [k("KeyG")], palette: false },
  { id: "ticket.bottom", label: "Scroll to bottom", group: "Ticket", scope: "ticket", keys: [k("KeyG", { shift: true })], palette: false },

  // Board
  { id: "board.left", label: "Card to the left", group: "Board", scope: "board", keys: [k("KeyH"), k("ArrowLeft")], palette: false },
  { id: "board.right", label: "Card to the right", group: "Board", scope: "board", keys: [k("KeyL"), k("ArrowRight")], palette: false },
  { id: "board.up", label: "Card above", group: "Board", scope: "board", keys: [k("KeyK"), k("ArrowUp")], palette: false },
  { id: "board.down", label: "Card below", group: "Board", scope: "board", keys: [k("KeyJ"), k("ArrowDown")], palette: false },
  { id: "board.first", label: "First card in the column", group: "Board", scope: "board", keys: [k("KeyG")], palette: false },
  { id: "board.last", label: "Last card in the column", group: "Board", scope: "board", keys: [k("KeyG", { shift: true })], palette: false },
  { id: "board.open", label: "Open the card", group: "Board", scope: "board", keys: [k("Enter")], palette: false },
  { id: "board.search", label: "Search tickets", group: "Board", scope: "board", keys: [k("Slash")] },

  // Lists (the sidebar, the inbox, a conductor's Tickets tab)
  { id: "list.next", label: "Next item", group: "Lists", scope: "list", keys: [k("KeyJ"), k("ArrowDown")], palette: false },
  { id: "list.prev", label: "Previous item", group: "Lists", scope: "list", keys: [k("KeyK"), k("ArrowUp")], palette: false },
  { id: "list.first", label: "First item", group: "Lists", scope: "list", keys: [k("KeyG"), k("Home")], palette: false },
  { id: "list.last", label: "Last item", group: "Lists", scope: "list", keys: [k("KeyG", { shift: true }), k("End")], palette: false },
  { id: "sidebar.exit", label: "Back to the panes", group: "Lists", scope: "sidebar", keys: [k("KeyL"), k("ArrowRight")], palette: false },

  // Actions: palette only (and their buttons). Never a bare key.
  ...(
    [
      ["ticket.start", "Start work"],
      ["ticket.approve", "Approve"],
      ["ticket.approveNoAction", "Approve and take no action"],
      ["ticket.requestChanges", "Request changes…"],
      ["ticket.complete", "Complete…"],
      ["ticket.rerunReview", "Re-run agent review"],
      ["ticket.cancelRun", "Cancel run"],
      ["ticket.markDone", "Mark done"],
      ["ticket.reopen", "Re-open…"],
      ["ticket.copyKey", "Copy ticket key"],
      ["ticket.openExternal", "Open in source tracker"],
      ["ticket.delete", "Delete ticket…"],
    ] as const
  ).map(([id, label]): CommandSpec => ({ id, label, group: "Actions", scope: "ticket", keys: [] })),
];

export const COMMAND_BY_ID: ReadonlyMap<string, CommandSpec> = new Map(COMMANDS.map((c) => [c.id, c]));

/** The event fields matching needs (a KeyboardEvent, or a test's literal). */
export type KeyEventLike = Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** A ⌘ chord (the everywhere tier); anything else is a movement key. */
export const isGlobalChord = (c: Chord) => !!c.meta;

export function chordMatches(c: Chord, e: KeyEventLike): boolean {
  // Numpad Enter is Enter.
  const code = e.code === "NumpadEnter" ? "Enter" : e.code;
  return c.code === code && !!c.meta === e.metaKey && !!c.ctrl === e.ctrlKey && !!c.alt === e.altKey && !!c.shift === e.shiftKey;
}

/** Where the focus is, as far as the tiers care. */
export interface KeyContext {
  /** An input, textarea, select or contenteditable has focus. */
  inText: boolean;
  /** The browser canvas or a terminal has focus: they take every key but ⌘ chords. */
  inCapture: boolean;
  /** A modal, menu or the palette is open. */
  overlay: boolean;
  /** Focus is on a button, link or other control. */
  onControl: boolean;
}

/**
 * The commands `e` could run in an area of `scope`, in registry order: those with a chord matching
 * the event that the tiers allow here. Movement keys never fire in text fields, capturing surfaces
 * (the canvas, terminals) or overlays; ⌘ chords fire everywhere but overlays, unless inOverlay.
 */
export function matchCommands(e: KeyEventLike, scope: KeyScope, ctx: KeyContext): CommandSpec[] {
  return COMMANDS.filter((c) => {
    if (c.scope !== scope) return false;
    const chord = c.keys.find((ch) => chordMatches(ch, e));
    if (!chord) return false;
    if (ctx.overlay && !c.inOverlay) return false;
    if (isGlobalChord(chord)) return true;
    if (ctx.inText || ctx.inCapture) return false;
    return !(c.notOnControl && ctx.onControl);
  });
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const KEY_LABEL: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "↩",
  Escape: "Esc",
  Space: "Space",
  Slash: "/",
  Comma: ",",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Home: "Home",
  End: "End",
};

/** What a code's key is called: KeyG → "g" (shifted → "G"), Digit1 → "1", Slash → "/" (shifted → "?"). */
function keyName(c: Chord): string {
  if (c.code.startsWith("Key")) {
    const letter = c.code.slice(3);
    return c.meta || c.ctrl || c.shift ? letter : letter.toLowerCase();
  }
  if (c.code.startsWith("Digit")) return c.code.slice(5);
  if (c.shift && !c.meta && c.code === "Slash") return "?";
  return KEY_LABEL[c.code] ?? c.code;
}

/**
 * A chord as the Mac menus write it: ⌃⌥⇧⌘ then the key ("⌥⌘←", "⇧⌘]", "⌘K"). A shifted letter or
 * "?" without ⌘ is written as the character typed ("G", "?").
 */
export function formatChord(c: Chord): string {
  const typedShift = !c.meta && !c.ctrl && !c.alt && c.shift && (c.code.startsWith("Key") || c.code === "Slash");
  return (c.ctrl ? "⌃" : "") + (c.alt ? "⌥" : "") + (c.shift && !typedShift ? "⇧" : "") + (c.meta ? "⌘" : "") + keyName(c);
}

const ACCEL_KEY: Record<string, string> = {
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Enter: "Return",
  Escape: "Escape",
  Space: "Space",
  Slash: "/",
  Comma: ",",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
};
/** The shifted character of a punctuation key; macOS matches menu key equivalents by character. */
const SHIFTED: Record<string, string> = { BracketLeft: "{", BracketRight: "}", Slash: "?" };

/**
 * A ⌘ chord as an Electron accelerator ("Cmd+Alt+Left", "Ctrl+Cmd+S"). Shifted punctuation is given
 * as its character ("Cmd+}" for ⇧⌘]): macOS matches key equivalents by the character typed, so
 * "Shift+]" would never fire. Null for chords without ⌘ (they're the renderer's alone).
 */
export function accelerator(c: Chord): string | null {
  if (!c.meta) return null;
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  parts.push("Cmd");
  if (c.alt) parts.push("Alt");
  const shifted = c.shift ? SHIFTED[c.code] : undefined;
  if (c.shift && !shifted) parts.push("Shift");
  const key = shifted ?? (c.code.startsWith("Key") ? c.code.slice(3) : c.code.startsWith("Digit") ? c.code.slice(5) : ACCEL_KEY[c.code] ?? c.code);
  return [...parts, key].join("+");
}

/** The menu-bar accelerator for a command: its first ⌘ chord. */
export function commandAccelerator(id: string): string | undefined {
  const c = COMMAND_BY_ID.get(id)?.keys.find(isGlobalChord);
  return (c && accelerator(c)) ?? undefined;
}

/** A command's shortcuts for display ("⇧⌘]"), ⌘ chords first. */
export function commandKeys(id: string): string[] {
  const keys = COMMAND_BY_ID.get(id)?.keys ?? [];
  return [...keys.filter(isGlobalChord), ...keys.filter((c) => !isGlobalChord(c))].map(formatChord);
}

/**
 * Whether `e` is one of the app's ⌘ chords (in any scope). Surfaces that forward keys elsewhere
 * (the browser canvas, to its page) keep these for the app.
 */
export const isAppChord = (e: KeyEventLike): boolean => COMMANDS.some((c) => c.keys.some((ch) => isGlobalChord(ch) && chordMatches(ch, e)));
