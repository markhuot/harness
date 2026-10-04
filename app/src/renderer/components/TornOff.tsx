// What a ticket pane shows in place of a tab that's torn off into a pane or window of its own
// (state/panes.ts "ticketTab"): the tab stays in the strip, and selecting it shows where it went
// with a Return to this window button. The composer gets a one-line bar instead.

import type { TornOff } from "../state/panes";
import { Icon } from "./Icon";

const where = (t: TornOff) => (t.window ? "in another window" : "in another pane");

/** The body of a torn-off tab (or the canvas of a torn-off browser tab): where it is, and the way back. */
export function TornPlaceholder({ name, torn, onReturn }: { name: string; torn: TornOff; onReturn: () => void }) {
  return (
    <div className="empty torn-placeholder" data-testid="torn-placeholder" style={{ flex: 1 }}>
      <Icon name="popout" />
      <strong>
        {name} is {where(torn)}
      </strong>
      <button className="btn" data-testid="torn-return" onClick={onReturn}>
        <Icon name="popin" /> Return to this window
      </button>
    </div>
  );
}

/** Where the composer was, while it's torn off: one line with the way back. */
export function ComposerReturnBar({ torn, onReturn }: { torn: TornOff; onReturn: () => void }) {
  return (
    <div className="composer-return" data-testid="composer-return">
      <Icon name="popout" size={13} />
      <span className="muted">The message box is {where(torn)}</span>
      <div className="grow" />
      <button className="btn btn-ghost btn-sm" data-testid="torn-return" onClick={onReturn}>
        <Icon name="popin" /> Return to this window
      </button>
    </div>
  );
}

/** The small mark a torn-off tab's button (or browser chip) carries in the strip. */
export function TornMark({ torn }: { torn: TornOff }) {
  return (
    <span className="torn-mark" data-testid="torn-mark" title={`Torn off: ${where(torn)}`}>
      <Icon name="popout" size={10} />
    </span>
  );
}
