// Ghostty's own word-skip: its default keybinds send ESC b / ESC f for Opt+←/→, which zsh and readline bind
// to backward-word / forward-word. ghostty-web ships only the encoder, which turns the same keys into
// CSI 1;3D / CSI 1;3C that nothing binds, so the view brings the keybind back. Opt+Backspace already
// encodes as ESC DEL and Opt+letter stays a typed character (a German layout types @ [ | with it).

/** The bytes for Opt+← / Opt+→ alone (no Shift, Ctrl or ⌘, not mid-composition), else null. */
export function wordSkipSequence(e: Pick<KeyboardEvent, "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing">): string | null {
  if (!e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || e.isComposing) return null;
  if (e.key === "ArrowLeft") return "\x1bb";
  if (e.key === "ArrowRight") return "\x1bf";
  return null;
}
