// Keyboard commands wired to the DOM (the registry itself is state/keys.ts).
//
// Areas that own commands mark themselves with data-keys-scope (their KeyScope, or several
// separated by spaces) and data-keys-owner (a unique id), and register handlers for that owner with
// useCommands. A key goes to the innermost area around the focus with a handler for a matching
// command, then outward, and last to the "global" owner. With nothing focused, the focused pane
// counts as where the focus is. The native menu (and the palette) run commands by id through the
// same lookup, which is how ⌘ chords reach the app from inside a plugin iframe or a terminal.

import { useEffect, useRef } from "react";
import { COMMAND_BY_ID, COMMANDS, matchCommands, type CommandSpec, type KeyContext, type KeyScope } from "../state/keys";
import { installModality, setModality } from "../state/inputModality";

/** A handler, or a falsy value when the command doesn't apply right now (it's then skipped and hidden from the palette). */
export type CommandHandlers = Record<string, (() => void) | false | null | undefined>;

export const GLOBAL_OWNER = "global";

const owners = new Map<string, Set<{ current: CommandHandlers }>>();

/**
 * Register `handlers` for `owner` while mounted. They're read when a key arrives, so they can
 * close over the latest render; several components may register for one owner (the first with a
 * handler for a command wins).
 */
export function useCommands(owner: string | null, handlers: CommandHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    if (!owner) return;
    let set = owners.get(owner);
    if (!set) owners.set(owner, (set = new Set()));
    set.add(ref);
    return () => {
      set!.delete(ref);
      if (!set!.size) owners.delete(owner);
    };
  }, [owner]);
}

function handlerFor(owner: string, id: string): (() => void) | null {
  for (const ref of owners.get(owner) ?? []) {
    const h = ref.current[id];
    if (h) return h;
  }
  return null;
}

/** The DOM attributes that make an element a command area. */
export const keysArea = (scope: KeyScope | `${KeyScope} ${string}`, owner: string) => ({ "data-keys-scope": scope, "data-keys-owner": owner });

interface Area {
  owner: string;
  scopes: KeyScope[];
}

/** Where commands for `el` are looked up: its areas from the innermost out, then the global owner. */
function areasFrom(el: Element | null): Area[] {
  const out: Area[] = [];
  for (let n = el?.closest("[data-keys-owner]") ?? null; n; n = n.parentElement?.closest("[data-keys-owner]") ?? null) {
    const h = n as HTMLElement;
    out.push({ owner: h.dataset.keysOwner!, scopes: (h.dataset.keysScope ?? "").split(/\s+/).filter(Boolean) as KeyScope[] });
  }
  out.push({ owner: GLOBAL_OWNER, scopes: ["global"] });
  return out;
}

/** The element key commands start from: the focus, or the focused pane when nothing (or the page) has it. */
export function commandOrigin(): Element | null {
  const a = document.activeElement;
  if (a && a !== document.body && a !== document.documentElement) return a;
  // The pane's command area sits inside the pane, so start from it (areas are looked up outward).
  const pane = document.querySelector(".pane.active");
  return pane?.querySelector("[data-keys-owner]") ?? pane;
}

const TEXT = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=color]), textarea, select, [contenteditable=""], [contenteditable=true]';
const CAPTURE = "canvas, [data-terminal]";
const CONTROL = "button, a[href], summary, [role=button], [role=tab], [role=menuitem], [role=menuitemcheckbox], [role=switch], input";
const OVERLAY = ".modal, .menu, .palette";

export function keyContext(el: Element | null): KeyContext {
  return {
    inText: !!el?.closest(TEXT),
    inCapture: !!el?.closest(CAPTURE),
    overlay: !!document.querySelector(OVERLAY),
    onControl: !!el?.closest(CONTROL),
  };
}

/** The command a key event runs, and its handler, or null. */
export function resolveKey(e: KeyboardEvent): { spec: CommandSpec; run: () => void } | null {
  const el = e.target instanceof Element && e.target !== document.body ? e.target : commandOrigin();
  const ctx = keyContext(el);
  for (const area of areasFrom(el)) {
    for (const scope of area.scopes) {
      for (const spec of matchCommands(e, scope, ctx)) {
        const run = handlerFor(area.owner, spec.id);
        if (run) return { spec, run };
      }
    }
  }
  return null;
}

/** The handler `id` has from `from` (default: where the focus is), or null when it doesn't apply there. */
export function commandHandler(id: string, from: Element | null = commandOrigin()): (() => void) | null {
  const spec = COMMAND_BY_ID.get(id);
  if (!spec) return null;
  for (const area of areasFrom(from)) if (area.scopes.includes(spec.scope)) {
    const run = handlerFor(area.owner, id);
    if (run) return run;
  }
  return null;
}

/** Every palette-listed command that applies from `from`, in registry order. */
export function availableCommands(from: Element | null): { spec: CommandSpec; run: () => void }[] {
  const out: { spec: CommandSpec; run: () => void }[] = [];
  for (const spec of COMMANDS) {
    if (spec.palette === false) continue;
    const run = commandHandler(spec.id, from);
    if (run) out.push({ spec, run });
  }
  return out;
}

// A key the renderer handled mustn't also arrive as the menu command (a ⌘ key the page handles
// normally never reaches the menu; this is the belt to that suspenders).
const handledAt = new Map<string, number>();
const DEDUPE_MS = 400;

/** Run a command by id (the menu bar, the palette): false when it doesn't apply where the focus is. */
export function runCommand(id: string, from: Element | null = commandOrigin()): boolean {
  const run = commandHandler(id, from);
  if (!run) return false;
  run();
  return true;
}

/**
 * The app's one keydown listener, and the menu bridge. Call once, in the shell. Components'
 * own key handling (a text field's Escape, a menu's arrows) runs first and wins by calling
 * preventDefault or stopPropagation.
 */
export function useKeyboardDispatcher() {
  useEffect(() => {
    installModality();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const hit = resolveKey(e);
      if (!hit) return;
      e.preventDefault();
      handledAt.set(hit.spec.id, performance.now());
      setModality("keyboard");
      hit.run();
    };
    addEventListener("keydown", onKey);
    const off = window.harness?.onMenu((id, viaKey) => {
      if (performance.now() - (handledAt.get(id) ?? -Infinity) < DEDUPE_MS) return;
      // A menu shortcut is the keyboard too (a click on the menu item isn't).
      if (viaKey) setModality("keyboard");
      runCommand(id);
    });
    return () => {
      removeEventListener("keydown", onKey);
      off?.();
    };
  }, []);
}
