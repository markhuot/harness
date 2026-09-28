// The keyboard shortcuts overlay (placeholder; filled in by the overlay work).

import { Modal } from "../components/bits";

export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return <Modal onClose={onClose}>{null}</Modal>;
}
