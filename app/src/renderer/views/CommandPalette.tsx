// ⌘K command palette (placeholder; filled in by the palette work).

export function CommandPalette({ origin, onClose, onShortcuts }: { origin: Element; onClose: () => void; onShortcuts: () => void }) {
  void origin;
  void onShortcuts;
  return <div className="palette" role="dialog" onClick={onClose} />;
}
