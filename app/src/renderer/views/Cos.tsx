// A chief of staff (#/cos/<scope>): its Chat and Inbox tabs under the pinned-ticket chrome, an
// on/off switch, and its Memory (a sheet, not a tab). The ticket detail assumes a work ticket
// (workdir, subagents, changes), so this reuses only its chrome (header, tab strip).

import { useState } from "react";
import { projectGroups, parseCosScopeKey, type Cos, type CosScopeKey } from "@harness/shared";
import { COS_TABS, COS_TAB_LABEL, cosBadgeCount, cosTitle, type CosTab } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { Switch } from "../components/bits";
import { useAction, useStore } from "../state/store";
import { CosChat } from "./CosChat";
import { CosInbox } from "./CosInbox";
import { CosMemory } from "./CosMemory";
import "./cos.css";

/** The chief that covers `scope`, if one was opened. */
export function chiefOf(chiefs: Record<string, Cos>, scope: CosScopeKey): Cos | undefined {
  return Object.values(chiefs).find((c) => c.scope === scope);
}

/** What the sidebar and the header call a scope's chief: "All projects" or its group's name. */
export function useCosTitle(scope: CosScopeKey): string {
  const { state } = useStore();
  const parsed = parseCosScopeKey(scope);
  const group = parsed && parsed !== "all" ? projectGroups(Object.values(state.projects)).find((g) => g.id === parsed.group) : undefined;
  return cosTitle({ scope }, group?.name ?? null);
}

/** Open (or create) a scope's chief and switch it on or off, keeping the store's copy current. */
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
    setEnabled: async (chief: Cos, enabled: boolean) => {
      const next = await act(() => client.setCosEnabled(chief.ticketId, enabled));
      if (next) dispatch({ type: "chief", chief: next });
    },
  };
}

export function CosView({ scope, tab }: { scope: CosScopeKey; tab: CosTab }) {
  const { state, navigate } = useStore();
  const title = useCosTitle(scope);
  const actions = useCosActions();
  const [memory, setMemory] = useState(false);
  const chief = chiefOf(state.chiefs, scope);
  const go = (t: CosTab) => navigate({ view: "cos", scope, tab: t });

  return (
    <div className="view cos" data-testid="cos-view" data-scope={scope}>
      <div className="view-header detail-titlebar">
        <Icon name="bot" />
        <span className="detail-title" data-testid="cos-title">
          Chief of staff · {title}
        </span>
        <div className="grow" />
        {chief && (
          <>
            <button className="btn btn-sm" data-testid="cos-memory-open" onClick={() => setMemory(true)}>
              <Icon name="fileText" size={12} /> Memory
            </button>
            <Switch checked={chief.enabled} ariaLabel={`Chief of staff for ${title} on`} label={chief.enabled ? "On" : "Off"} onChange={(v) => void actions.setEnabled(chief, v)} />
          </>
        )}
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
          <div className="detail-body cos-body">{tab === "chat" ? <CosChat chief={chief} /> : <CosInbox chief={chief} onChat={() => go("chat")} />}</div>
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
    </div>
  );
}
