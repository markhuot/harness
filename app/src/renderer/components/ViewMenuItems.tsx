// The "…" menu's view items, the same on the file pane and the Spec tab: Source / Rendered, Wrap lines
// (source only: rendered text always wraps) and, on the Spec tab, Show changes. What's offered and
// enabled is shared/src/viewOptions.ts's viewMenu.

import type { ViewMenu } from "@harness/shared";
import { Icon } from "./Icon";

const tick = (on: boolean) => on && <span style={{ marginLeft: "auto" }}><Icon name="check" /></span>;

export function ViewMenuItems({
  menu,
  wrap,
  onRendered,
  onWrap,
  showChanges,
  onShowChanges,
  onDone,
}: {
  menu: ViewMenu;
  wrap: boolean;
  /** `rendered` is what was asked for; null leaves Show changes alone */
  onRendered: (rendered: boolean) => void;
  onWrap: (wrap: boolean) => void;
  showChanges?: boolean;
  onShowChanges?: (on: boolean) => void;
  onDone: () => void;
}) {
  const run = (fn: () => void) => () => (onDone(), fn());
  if (!menu.view && !menu.showChanges && !menu.wrapEnabled) return null;
  return (
    <>
      {menu.view && (
        <>
          <button role="menuitemradio" aria-checked={!menu.rendered} disabled={!menu.sourceEnabled} data-testid="view-source" onClick={run(() => onRendered(false))}>
            <Icon name="fileText" /> Source {tick(!menu.rendered)}
          </button>
          <button role="menuitemradio" aria-checked={menu.rendered} data-testid="view-rendered" onClick={run(() => onRendered(true))}>
            <Icon name="eye" /> Rendered {tick(menu.rendered)}
          </button>
        </>
      )}
      {menu.showChanges && (
        <button role="menuitemcheckbox" aria-checked={!!showChanges} data-testid="view-changes" onClick={run(() => onShowChanges?.(!showChanges))}>
          <Icon name="layers" /> Show changes {tick(!!showChanges)}
        </button>
      )}
      <button role="menuitemcheckbox" aria-checked={wrap} disabled={!menu.wrapEnabled} data-testid="view-wrap" onClick={run(() => onWrap(!wrap))}>
        <Icon name="ruler" /> Wrap lines {tick(wrap)}
      </button>
      <hr />
    </>
  );
}
