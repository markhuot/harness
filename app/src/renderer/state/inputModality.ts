// Keyboard vs pointer modality. Focus rings for panes (and the board's parked cursor) show only
// while you're driving the app from the keyboard: html[data-input="keyboard"] is set whenever a
// keyboard command runs or Tab moves focus, and any pointer press sets it back to "pointer".
// Typing into a text field doesn't count; it's neither navigating nor a reason to show rings.

export type Modality = "keyboard" | "pointer";

let lastInputAt = 0;

export function setModality(m: Modality) {
  const el = document.documentElement;
  if (el.dataset.input !== m) el.dataset.input = m;
}

export const modality = (): Modality => (document.documentElement.dataset.input === "keyboard" ? "keyboard" : "pointer");

/**
 * True when the user pressed a key or the pointer within the last `ms`: focus that moves then is
 * theirs, while focus moved with no input nearby is programmatic (an autofocus, a ticket asking
 * for an answer) and shouldn't retarget the focused pane.
 */
export const userInputWithin = (ms: number) => performance.now() - lastInputAt < ms;

let installed = false;
/** Start tracking (once, from the app shell). */
export function installModality() {
  if (installed) return;
  installed = true;
  setModality("pointer");
  addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      lastInputAt = performance.now();
      if (e.key === "Tab") setModality("keyboard");
    },
    true,
  );
  addEventListener(
    "pointerdown",
    () => {
      lastInputAt = performance.now();
      setModality("pointer");
    },
    true,
  );
}
