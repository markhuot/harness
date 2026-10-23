// A chief of staff: a callout card on the board (CosCallout, not in a column) that opens its pane
// (CosPane): its Chat, Inbox and Listeners tabs under the ticket pane's chrome and its
// Memory (a sheet, not a tab). The ticket detail assumes a work ticket (workdir, subagents,
// changes), so this reuses only its chrome (header, tab strip).

import { useState } from "react";
import { cosScopeKey, projectGroups, parseCosScopeKey, type Cos, type CosScopeKey } from "@harness/shared";
import { scopeGroup } from "@harness/shared/state";
import { COS_TABS, COS_TAB_LABEL, cosBadgeCount, cosTitle, type CosTab } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { PaneGrip } from "../components/paneHeader";
import { keysArea } from "../components/commands";
import { commandKeys } from "../state/keys";
import { usePaneScope } from "../components/paneContext";
import { closePane, openCos, setCosTab, updatePanes } from "../state/panes";
import type { CosContent } from "../state/paneModel";
import { useAction, useStore } from "../state/store";
import { CosChat } from "./CosChat";
import { CosInbox } from "./CosInbox";
import { CosListeners } from "./CosListeners";
import { CosMemory } from "./CosMemory";
import "./cos.css";

/** The chief that covers `scope`, if one was opened. */
export function chiefOf(chiefs: Record<string, Cos>, scope: CosScopeKey): Cos | undefined {
  return Object.values(chiefs).find((c) => c.scope === scope);
}

/** The scope whose chief a board shows: its group's, or All projects for a board with no group. */
export function boardCosScope(projects: Record<string, { groupId?: string | null }>, boardScope: string, boardProjectId: string | null): CosScopeKey {
  const group = scopeGroup(boardScope) ?? (boardProjectId ? (projects[boardProjectId]?.groupId ?? null) : null);
  return group ? cosScopeKey({ group }) : "all";
}

/** What the board card and the header call a scope's chief: "All projects" or its group's name. */
export function useCosTitle(scope: CosScopeKey): string {
  const { state } = useStore();
  const parsed = parseCosScopeKey(scope);
  const group = parsed && parsed !== "all" ? projectGroups(Object.values(state.projects)).find((g) => g.id === parsed.group) : undefined;
  return cosTitle({ scope }, group?.name ?? null);
}

/** Open (or create) a scope's chief, keeping the store's copy current. */
export function useCosActions() {
  const { client, dispatch } = useStore();
  const act = useAction();
  return {
    /** The chief of `scope`, made on first use. */
    open: async (scope: CosScopeKey) => {
      const chief = await act(() => client.openCos(scope));
      if (chief) dispatch({ type: "chief", chief });
      return chief;
    },
  };
}

/** The board title bar's button to its chief of staff, with a pill for what waits. */
export function CosCallout({ scope }: { scope: CosScopeKey }) {
  const { state } = useStore();
  const boardScope = usePaneScope();
  const title = useCosTitle(scope);
  const actions = useCosActions();
  const chief = chiefOf(state.chiefs, scope);
  const count = chief ? cosBadgeCount(state.cosBadge, chief.ticketId) : 0;
  const open = async () => {
    if (!chief) await actions.open(scope);
    updatePanes(boardScope, (s) => openCos(s, scope));
  };
  return (
    <button className="btn btn-sm cos-callout" data-testid="cos-callout" data-scope={scope} title={`Chief of Staff for ${title}`} onClick={() => void open()}>
      <Icon name="bot" size={13} />
      Chief of Staff
      {count > 0 && (
        <span className="nav-badge" data-testid="cos-callout-badge" title={`${count} event${count === 1 ? "" : "s"} waiting`}>
          {count}
        </span>
      )}
    </button>
  );
}

export function CosPane({ paneId, content }: { paneId: string; content: CosContent; zoomed?: boolean }) {
  const { state } = useStore();
  const boardScope = usePaneScope();
  const scope = content.scope as CosScopeKey;
  const tab = content.tab;
  const title = useCosTitle(scope);
  const actions = useCosActions();
  const [memory, setMemory] = useState(false);
  const chief = chiefOf(state.chiefs, scope);
  const go = (t: CosTab) => updatePanes(boardScope, (s) => setCosTab(s, paneId, t));
  const close = () => updatePanes(boardScope, (s) => closePane(s, paneId));

  return (
    <aside className="detail cos" data-testid="cos-view" data-scope={scope} {...keysArea("ticket", `cos:${paneId}`)}>
      <div className="view-header detail-titlebar">
        <PaneGrip paneId={paneId} chip="Chief of staff" title="" />
        <Icon name="bot" />
        <span className="detail-title" data-testid="cos-title">
          Chief of staff · {title}
        </span>
        <div className="grow" />
        {chief && (
          <button className="btn btn-sm" data-testid="cos-memory-open" onClick={() => setMemory(true)}>
            <Icon name="fileText" size={12} /> Memory
          </button>
        )}
        <button className="btn btn-ghost btn-icon" onClick={close} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane" data-testid="cos-close" data-pane-autofocus>
          <Icon name="x" />
        </button>
      </div>
      {chief ? (
        <>
          <nav className="tabs" role="tablist" aria-label="Chief of staff tabs">
            {COS_TABS.map((t) => (
              <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? "on" : ""}`} data-tab={t} onClick={() => go(t)}>
                {COS_TAB_LABEL[t]}
                {t === "inbox" && cosBadgeCount(state.cosBadge, chief.ticketId) > 0 && (
                  <span className="count" data-testid="cos-inbox-count">
                    {cosBadgeCount(state.cosBadge, chief.ticketId)}
                  </span>
                )}
              </button>
            ))}
          </nav>
          {chief.triageUnavailable && (
            <div className="cos-note" role="status">
              Triage is unavailable ({chief.triageUnavailable}), so every event wakes the chief.
            </div>
          )}
          <div className="detail-body cos-body">
            {tab === "chat" ? <CosChat chief={chief} /> : tab === "inbox" ? <CosInbox chief={chief} onChat={() => go("chat")} /> : <CosListeners chief={chief} onChat={() => go("chat")} />}
          </div>
          {memory && <CosMemory chief={chief} title={title} onClose={() => setMemory(false)} />}
        </>
      ) : (
        <div className="empty" style={{ flex: 1 }} data-testid="cos-none">
          <Icon name="bot" />
          <strong>No chief of staff for {title} yet</strong>
          It triages ticket moves, watcher items and schedules, and wakes only when something needs it.
          <button className="btn btn-primary btn-sm" data-testid="cos-create" onClick={() => void actions.open(scope)}>
            Turn on
          </button>
        </div>
      )}
    </aside>
  );
}
