// One of a ticket's tabs (or its composer) torn off into a pane of its own (state/panes.ts
// "ticketTab"), so a Spec and a Transcript, or two browser tabs and the Spec, show at once. The body
// is the same component the ticket pane shows for that tab, with the same handlers (TicketTabBody,
// MessageComposer), so it's fully working: the spec edits, Details changes settings, the browser
// takes input. The header is slim (the key, the tab, a pinned browser tab's title), with no strip;
// the ticket pane keeps the tab in its strip with a Return to this window placeholder.

import { useEffect, useRef, useState } from "react";
import { isConductor, keyLabel, type Ticket } from "@harness/shared";
import { effectiveTabWithChanges, subagentsOf, tabAfterSend, type TicketTab } from "@harness/shared/state";
import { useStore } from "../state/store";
import {
  closePane,
  COMPOSER_TAB,
  getPanes,
  isPopoutScope,
  openTicket,
  returnTabPane,
  setTab as setPaneTab,
  setTornTab,
  ticketLeafByKey,
  toggleZoom,
  tornId,
  updatePanes,
  usePaneStore,
  useTornOffTabs,
  type TicketTabContent,
} from "../state/panes";
import { keysArea, useCommands } from "../components/commands";
import { commandKeys } from "../state/keys";
import { Icon } from "../components/Icon";
import { MenuButton, TicketKey } from "../components/bits";
import { useBoardScope, usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { ApprovalCard } from "./Approval";
import { focusTicketComposer, MessageComposer, scrollCommands, TicketTabBody, tornTabName, useTicketActions, useTicketData, type BrowserOpts } from "./TicketDetail";

export function TicketTabPane({ paneId, content, zoomed }: { paneId: string; content: TicketTabContent; zoomed: boolean }) {
  const scope = usePaneScope();
  const { ticket, missing, related, pluginTabs } = useTicketData(content.ticketKey);
  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  if (ticket && !ticket.draft) return <TornTab paneId={paneId} content={content} zoomed={zoomed} ticket={ticket} related={related} pluginTabs={pluginTabs} onClose={close} />;
  return (
    <aside className="detail torn-pane" {...keysArea("ticket", `ticketTab:${paneId}`)}>
      <div className="view-header detail-titlebar">
        <PaneGrip paneId={paneId} chip={content.ticketKey} title="" />
        <span className="detail-key">{content.ticketKey}</span>
        <div className="grow" />
        <button className="btn btn-ghost btn-icon" onClick={close} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane" data-pane-autofocus>
          <Icon name="x" />
        </button>
      </div>
      <div className="empty" style={{ flex: 1 }}>
        {ticket?.draft ? (
          "A draft has no tabs yet. Its New session editor is in its ticket pane."
        ) : missing ? (
          <>
            <Icon name="alert" />
            <strong>{content.ticketKey} not found</strong>
            It may have been deleted.
          </>
        ) : (
          <div className="spinner" />
        )}
      </div>
    </aside>
  );
}

function TornTab({
  paneId,
  content,
  zoomed,
  ticket,
  related,
  pluginTabs,
  onClose,
}: {
  paneId: string;
  content: TicketTabContent;
  zoomed: boolean;
  ticket: Ticket;
  related: ReturnType<typeof useTicketData>["related"];
  pluginTabs: ReturnType<typeof useTicketData>["pluginTabs"];
  onClose: () => void;
}) {
  const { state } = useStore();
  const scope = usePaneScope();
  const boardScope = useBoardScope();
  const popout = usePopout();
  const store = usePaneStore();
  const torn = useTornOffTabs(ticket.key, boardScope);
  const owner = `ticketTab:${paneId}`;
  const ref = useRef<HTMLElement>(null);
  const [browserTitle, setBrowserTitle] = useState("");
  const composer = content.tab === COMPOSER_TAB;
  const pinned = content.browserTab !== undefined;
  const back = () => returnTabPane(boardScope, ticket.key, tornId(content));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));
  // The ticket's actions work from here as from its pane (the palette, the approval card).
  const { modals } = useTicketActions(owner, ticket, onClose);
  useCommands(owner, {
    "ticket.compose": () => focusTicketComposer(ticket.key, torn.get(COMPOSER_TAB), boardScope),
    ...scrollCommands(() => ref.current?.querySelector(".detail-body") ?? null),
  });

  // A composer in a window of its own: when `i` brings the window forward, the input takes the keyboard.
  useEffect(() => {
    if (!popout || !composer) return;
    const focus = () => ref.current?.querySelector<HTMLElement>(".composer-input")?.focus();
    addEventListener("focus", focus);
    return () => removeEventListener("focus", focus);
  }, [popout, composer]);

  /** The ticket's own pane, in this board or a pop-out window (null when it's closed). */
  const ticketPaneOpen = Object.entries(store.scopes).some(([sc, s]) => (sc === boardScope || isPopoutScope(sc)) && !!ticketLeafByKey(s.root, ticket.key));

  // Moving inside the tab (Agents ⇄ a sub-agent) stays here; anything else opens in the ticket's pane.
  const setTab = (t: TicketTab) => {
    if (tornId({ tab: t }) === tornId(content)) updatePanes(scope, (s) => setTornTab(s, paneId, t));
    else updatePanes(boardScope, (s) => openTicket(s, ticket.key, t));
  };

  // After a send from a torn-off composer, the ticket pane shows the Transcript (unless that's torn off too).
  const afterSend = () => {
    if (torn.has("transcript")) return;
    const leaf = ticketLeafByKey(getPanes(boardScope).root, ticket.key);
    if (leaf?.content.kind === "ticket") updatePanes(boardScope, (s) => setPaneTab(s, leaf.id, tabAfterSend(leaf.content.kind === "ticket" ? leaf.content.tab : "spec", true)));
  };

  const subagents = subagentsOf(state, ticket.sessionId);
  const tab = composer ? null : effectiveTabWithChanges(content.tab as TicketTab, { conductor: isConductor(ticket), workdir: ticket.workdir, pluginTabs, subagents });
  // The tab doesn't apply to this ticket (any more): there's nothing to show.
  const gone = tab !== null && tornId({ tab }) !== tornId({ tab: content.tab });
  const name = tornTabName(content.tab, pluginTabs);
  const browser: BrowserOpts = pinned
    ? { pinnedTab: content.browserTab, onPinnedClosed: onClose, onTitle: setBrowserTitle }
    : { tear: { ticketKey: ticket.key, scope, boardScope, paneId, torn } };
  // An approval shows where it gets answered (beside the composer or the transcript), or anywhere with the ticket's pane closed.
  const approval = ticket.pendingApproval && (composer || content.tab === "transcript" || !ticketPaneOpen);

  return (
    <aside className={`detail torn-pane ${composer ? "torn-composer" : ""}`} ref={ref} {...keysArea("ticket", owner)} data-torn-tab={tornId(content)}>
      <div className="view-header detail-titlebar torn-titlebar">
        <PaneGrip paneId={paneId} chip={ticket.key} label={keyLabel(ticket)} title={ticket.title} />
        <span className="detail-key selectable">
          <TicketKey ticket={ticket} />
        </span>
        <span className="torn-tab-name" data-testid="torn-tab-name">
          {name}
        </span>
        {pinned && browserTitle && (
          <span className="torn-browser-title truncate muted" title={browserTitle}>
            {browserTitle}
          </span>
        )}
        <div className="grow" />
        <MenuButton
          trigger={(toggle) => (
            <button className="btn btn-ghost btn-icon" onClick={toggle} title="More" data-testid="torn-more">
              <Icon name="more" />
            </button>
          )}
        >
          {(closeMenu) => (
            <>
              <button data-testid="torn-return-menu" onClick={() => (closeMenu(), back())}>
                <Icon name="popin" /> Return to ticket
              </button>
              <hr />
              <MovePaneItems paneId={paneId} onDone={closeMenu} />
            </>
          )}
        </MenuButton>
        <PaneWindowButton paneId={paneId} />
        {!popout && (
          <button
            className="btn btn-ghost btn-icon"
            data-testid="pane-zoom"
            aria-pressed={zoomed}
            onClick={zoom}
            title={zoomed ? "Restore pane" : "Maximize pane"}
            aria-label={zoomed ? "Restore pane" : "Maximize pane"}
          >
            <Icon name={zoomed ? "shrink" : "expand"} />
          </button>
        )}
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={onClose} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane" data-pane-autofocus>
          <Icon name="x" />
        </button>
      </div>
      {approval && (
        <div className="torn-approval">
          <ApprovalCard key={ticket.pendingApproval!.id} ticket={ticket} approval={ticket.pendingApproval!} />
        </div>
      )}
      {composer ? (
        <MessageComposer ticket={ticket} key={ticket.id} onSent={afterSend} fill />
      ) : gone ? (
        <div className="empty" style={{ flex: 1 }}>
          <strong>{name} isn't available on {keyLabel(ticket)}</strong>
        </div>
      ) : (
        <div className="detail-body">
          <TicketTabBody ticket={ticket} tab={tab!} requested={content.tab as TicketTab} pluginTabs={pluginTabs} related={related} setTab={setTab} browser={browser} />
        </div>
      )}
      {modals}
    </aside>
  );
}
