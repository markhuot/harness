// How much of a view the iOS keyboard covers, from the view's frame in window coordinates and the
// keyboard's end frame (screen coordinates, which match the window's on iPhone).
//
// React Native's KeyboardAvoidingView does this sum with its onLayout frame, which is relative to
// its parent, not the window. Under a navigation header or inside a sheet that frame starts at 0
// while the view really starts lower on screen, so it pads by the keyboard height minus that
// offset and leaves the bottom of the screen hidden behind the keyboard.

export interface KeyboardFrame {
  screenY: number;
  height: number;
}

export function keyboardOverlap(view: { y: number; height: number }, keyboard: KeyboardFrame | null): number {
  if (!keyboard || keyboard.height <= 0) return 0;
  // A floating or undocked iPad keyboard reports itself at the top of the screen; it doesn't push
  // anything up.
  if (keyboard.screenY <= 0) return 0;
  const covered = view.y + view.height - keyboard.screenY;
  return Math.round(Math.max(0, Math.min(covered, keyboard.height, view.height)));
}
