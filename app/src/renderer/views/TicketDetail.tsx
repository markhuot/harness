import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { conductorManagedReason, isConductor, keyLabel, managingConductor, resolveBaseBranch, type CompletionAction, type RelatedTicket, type RemoteKeyMatches, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import {
  AGENTS_LIVE_LABEL,
  childrenOf,
  COMPOSER_PLACEHOLDER,
  composerHint,
  depChipTitle,
  dependencyStates,
  effectiveTab,
  hasCustomDriver,
  moveSwitchLabel,
  nextTab,
  openingTab,
  parsePluginTab,
  parseSubagentTab,
  pluginTabRoute,
  progressOf,
  showsAgentsTab,
  isTask,
  subagentById,
  subagentsOf,
  subagentTabRoute,
  TAB_LABEL,
  tabStripTab,
  ticketByKey,
  TICKET_TABS,
  visibleTabs,
  type TicketTab,
} from "@harness/shared/state";
import { Icon, isIconName } from "../components/Icon";
import { FileLinkScope, Markdown } from "../components/Markdown";
import { Attachments } from "../components/Attachments";
import { ModelBadge } from "../components/ModelSelect";
import { DriverBadge, KindBadge, MenuButton, MOD, Modal, relativeTime, ReviewMark, StatusDot, StatusPill, Switch, TicketKey, useNow } from "../components/bits";
import { LandButton, LandSheet, type LandSheetState } from "../components/LandButton";
import { landCommands, landMenu, pullRequestLabel, type LandChoice } from "../state/approveMenu";
import { Transcript } from "./Transcript";
import { BrowserView } from "./BrowserView";
import { TicketDetails } from "./TicketDetails";
import { DraftEditor } from "./DraftEditor";
import { ApprovalCard } from "./Approval";
import { PluginFrame, usePluginTabs } from "./PluginTab";
import { ChildrenTab } from "./ChildrenTab";
import { AgentsTab, SubagentView, TaskView } from "./AgentsTab";
import { ConductorProgress, ParentCrumb } from "../components/Conductor";
import { ProjectKey } from "../components/ProjectKey";
import { MentionTextarea } from "../components/MentionTextarea";
import { useStickToBottom } from "../components/stickToBottom";
import { useOpenTicket, usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { closePane, renameTicketKey, setTab as setPaneTab, toggleZoom, updateAllPanes, updatePanes } from "../state/panes";
import { keysArea, useCommands } from "../components/commands";
import { commandKeys } from "../state/keys";
import { liveRelatedTickets, remoteKeyMatches } from "../state/remoteIds";

/** What a command's tooltip adds: " (⇧⌘])", or nothing for a command without keys. */
const keyHint = (id: string) => {
  const keys = commandKeys(id);
  return keys.length ? ` (${keys.join(" / ")})` : "";
};

/**
 * The tab body's scroller: the first element inside `root` that scrolls vertically (each tab has
 * its own, e.g. the transcript's or the summaries' list). Null for tabs that don't scroll here,
 * like the browser canvas or a plugin iframe.
 */
function scrollerIn(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null;
  const queue: HTMLElement[] = [root];
  while (queue.length) {
    const el = queue.shift()!;
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    queue.push(...(Array.from(el.children) as HTMLElement[]));
  }
  return null;
}

const LINE = 48;

/** A ticket's pane in the workspace (components/PaneWorkspace.tsx); its key and tab are the pane's content. */
export function TicketDetail({
  paneId,
  ticketKey,
  tab: paneTab,
  zoomed,
  tabChosen = false,
}: {
  paneId: string;
  ticketKey: string;
  tab: TicketTab;
  zoomed: boolean;
  /** The pane's tab was picked for it (a draft just submitted from this pane): keep it. */
  tabChosen?: boolean;
}) {
  const { state, client, dispatch, epoch } = useStore();
  const scope = usePaneScope();
  // Not found: gone (true), or a remote ID that linked tickets carry (their list, remote-only pane).
  const [missing, setMissing] = useState<boolean | RemoteKeyMatches>(false);
  // By key, or by an old key the service already resolved (the effect below redirects to the new one).
  const ticket = useMemo(() => ticketByKey(state, ticketKey), [state.tickets, state.keyAliases, ticketKey]);
  const pluginTabs = usePluginTabs(ticket);
  // The detail's relatedTickets (the Details tab's External row); refetched when the link changes.
  const [related, setRelated] = useState<RelatedTicket[] | undefined>(undefined);
  const remoteId = ticket?.externalRef?.key ?? null;
  /** The remote ID `related` was fetched for (undefined until the detail loads) */
  const relatedFor = useRef<string | null | undefined>(undefined);

  // Detail (summaries, runs, session) — refetch on reconnect.
  useEffect(() => {
    let cancelled = false;
    client
      .getTicket(ticketKey)
      .then((detail) => {
        if (cancelled) return;
        dispatch({ type: "detail", detail, requestedKey: ticketKey });
        setRelated(detail.relatedTickets);
        relatedFor.current = detail.ticket.externalRef?.key ?? null;
        setMissing(false);
        // An old key (from before a project rename) resolves to the ticket's current key; follow it
        // on every board (another board's panes may have it open under the old key too).
        if (detail.ticket.key !== ticketKey) updateAllPanes((s) => renameTicketKey(s, ticketKey, detail.ticket.key));
      })
      .catch((e) => !cancelled && setMissing(remoteKeyMatches(e) ?? true));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, ticketKey, epoch]);
  // Linked, unlinked or relinked since (Ticket settings, triage): the related list is another one.
  useEffect(() => {
    if (relatedFor.current === undefined || relatedFor.current === remoteId) return;
    let cancelled = false;
    client.getTicket(ticketKey).then(
      (detail) => {
        if (cancelled) return;
        relatedFor.current = detail.ticket.externalRef?.key ?? null;
        setRelated(detail.relatedTickets);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client, ticketKey, remoteId]);

  // Escape (closing the focused pane, or ending a zoom) is handled by the workspace.
  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));

  // Keyboard: this pane is a "ticket" command area (state/keys.ts). The tabs are the strip's, in
  // order; the scroll keys move whichever scroller the current tab has.
  const owner = `ticket:${paneId}`;
  const asideRef = useRef<HTMLElement>(null);
  const subagents = ticket ? subagentsOf(state, ticket.sessionId) : null;
  const tabs = ticket ? visibleTabs({ conductor: isConductor(ticket), subagents, pluginTabs }) : [];
  // A plugin tab that doesn't apply (or no longer exists) falls back to Summaries once tabs are known.
  // Likewise the conductor-only Tickets tab on a plain ticket, and Agents on a session without sub-agents.
  const tab = ticket ? effectiveTab(paneTab, { conductor: isConductor(ticket), pluginTabs, subagents }) : paneTab;
  // A ticket opened on the default Summaries tab moves to the Transcript when it has no summaries.
  // Decided once per ticket the pane shows, when its summaries first load, so a later click on
  // Summaries stays there.
  const openedOn = useRef<string | null>(paneTab !== "summaries" || tabChosen ? ticketKey : null);
  const summaries = ticket ? state.summaries[ticket.sessionId] : undefined;
  const draft = !!ticket?.draft;
  useEffect(() => {
    if (openedOn.current === ticketKey) return;
    // A draft's pane has no tabs; submitting it picks the tab it goes to.
    if (draft) {
      openedOn.current = ticketKey;
      return;
    }
    if (paneTab !== "summaries") {
      openedOn.current = ticketKey;
      return;
    }
    const t = openingTab(summaries);
    if (!t) return;
    openedOn.current = ticketKey;
    if (t !== "summaries") updatePanes(scope, (s) => setPaneTab(s, paneId, t));
  }, [ticketKey, paneTab, summaries, scope, paneId, draft]);
  // A tab change from the keyboard keeps the focus on the strip when it was there.
  const refocusTab = useRef(false);
  const goTab = (t: TicketTab | null) => {
    if (!t) return;
    const a = document.activeElement;
    refocusTab.current = !!a?.closest("[role=tablist]") && !!asideRef.current?.contains(a);
    updatePanes(scope, (s) => setPaneTab(s, paneId, t));
  };
  useLayoutEffect(() => {
    if (!refocusTab.current) return;
    refocusTab.current = false;
    asideRef.current?.querySelector<HTMLElement>(".tabs [aria-selected=true]")?.focus();
  }, [tab]);
  const scroll = (fn: (el: HTMLElement) => void) => () => {
    const el = scrollerIn(asideRef.current?.querySelector(".detail-body") ?? null);
    if (el) fn(el);
  };
  useCommands(owner, {
    "tab.next": tabs.length > 1 && (() => goTab(nextTab(tabs, tab, 1))),
    "tab.prev": tabs.length > 1 && (() => goTab(nextTab(tabs, tab, -1))),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab.${i + 1}`, !!tabs[i] && (() => goTab(tabs[i]!))])),
    "ticket.compose": !!ticket && (() => asideRef.current?.querySelector<HTMLElement>(".composer-input")?.focus()),
    "ticket.scrollDown": scroll((el) => el.scrollBy({ top: LINE })),
    "ticket.scrollUp": scroll((el) => el.scrollBy({ top: -LINE })),
    "ticket.pageDown": scroll((el) => el.scrollBy({ top: el.clientHeight * 0.9 })),
    "ticket.pageUp": scroll((el) => el.scrollBy({ top: -el.clientHeight * 0.9 })),
    "ticket.top": scroll((el) => el.scrollTo({ top: 0 })),
    "ticket.bottom": scroll((el) => el.scrollTo({ top: el.scrollHeight })),
  });
  /** ←/→ (and Home/End) on a focused tab move along the strip, as in any tablist. */
  const tabKeys = (e: KeyboardEvent) => {
    const delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = delta ? nextTab(tabs, tab, delta) : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : null;
    if (!to || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    goTab(to);
  };

  if (!ticket && typeof missing === "object") return <RemoteIdPane paneId={paneId} owner={owner} matches={missing} onClose={close} />;

  if (!ticket) {
    return (
      <aside className="detail" ref={asideRef} {...keysArea("ticket", owner)}>
        <div className="view-header detail-titlebar">
          <PaneGrip paneId={paneId} chip={ticketKey} title="" />
          <span className="detail-key">{ticketKey}</span>
          <div className="grow" />
          <button className="btn btn-ghost btn-icon" onClick={close} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane" data-pane-autofocus>
            <Icon name="x" />
          </button>
        </div>
        <div className="empty" style={{ flex: 1 }}>
          {missing ? (
            <>
              <Icon name="alert" />
              <strong>{ticketKey} not found</strong>
              It may have been deleted.
            </>
          ) : (
            <div className="spinner" />
          )}
        </div>
      </aside>
    );
  }

  // A draft is edited, not worked on: the New session editor instead of the tabs.
  if (ticket.draft) return <DraftEditor paneId={paneId} ticket={ticket} zoomed={zoomed} />;

  const wantPlugin = parsePluginTab(paneTab);
  const activePlugin = wantPlugin ? pluginTabs?.find((t) => t.pluginId === wantPlugin.pluginId && t.id === wantPlugin.tabId) : undefined;
  const openAgent = parseSubagentTab(tab);
  const openedTask = openAgent ? isTask(subagentById(state, ticket.sessionId, openAgent) ?? {}) : false;
  const stripTab = tabStripTab(tab);
  const setTab = (t: TicketTab) => updatePanes(scope, (s) => setPaneTab(s, paneId, t));
  const openSubagent = (id: string) => setTab(subagentTabRoute(id));
  const childCount = isConductor(ticket) ? childrenOf(state, ticket.id).length : 0;
  const agentsRunning = subagents?.some((a) => a.status === "running") ?? false;

  // role=tab props: one tab stop (the current tab, where pane focus lands), the rest by ←/→.
  const tabProps = (on: boolean, t: TicketTab) => ({
    role: "tab",
    "aria-selected": on,
    tabIndex: on ? 0 : -1,
    "data-pane-autofocus": on || undefined,
    title: tabs.indexOf(t) >= 0 && tabs.indexOf(t) < 9 ? `Press ${tabs.indexOf(t) + 1}, or ⇧⌘[ / ⇧⌘] to go through the tabs` : undefined,
  });

  return (
    <aside className="detail" ref={asideRef} {...keysArea("ticket", owner)}>
      <DetailHeader paneId={paneId} owner={owner} ticket={ticket} onClose={close} zoomed={zoomed} onToggleZoom={zoom} onOpenChildren={() => setTab("children")} />
      <nav className="tabs" role="tablist" aria-label="Ticket tabs" onKeyDown={tabKeys}>
        {TICKET_TABS.filter((t) => (t !== "children" || isConductor(ticket)) && (t !== "agents" || showsAgentsTab(subagents))).map((t) => (
          <button key={t} className={`tab ${stripTab === t ? "on" : ""}`} onClick={() => setTab(t)} data-tab={t} {...tabProps(stripTab === t, t)}>
            {TAB_LABEL[t]}
            {t === "summaries" && (state.summaries[ticket.sessionId]?.length ?? 0) > 0 && <span className="count">{state.summaries[ticket.sessionId]!.length}</span>}
            {t === "children" && childCount > 0 && <span className="count">{childCount}</span>}
            {t === "agents" && (subagents?.length ?? 0) > 0 && <span className="count">{subagents!.length}</span>}
            {t === "agents" && agentsRunning && <span className="live-dot" title={AGENTS_LIVE_LABEL} />}
            {t === "transcript" && ticket.busy && <span className="live-dot" />}
          </button>
        ))}
        {pluginTabs?.map((p) => {
          const t = pluginTabRoute(p.pluginId, p.id);
          return (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)} data-plugin-tab={t} {...tabProps(tab === t, t)} title={`${p.title} (plugin: ${p.pluginId})`}>
              {p.icon && isIconName(p.icon) && <Icon name={p.icon} size={12} />}
              {p.title}
            </button>
          );
        })}
      </nav>
      <div className="detail-body">
        <FileLinkScope ticketKey={ticket.key} projectId={ticket.projectId}>
        {tab === "summaries" && <Summaries ticket={ticket} />}
        {tab === "children" && <ChildrenTab ticket={ticket} />}
        {tab === "transcript" && <Transcript sessionId={ticket.sessionId} onOpenSubagent={openSubagent} emptyHint="The agent's conversation will stream in here." />}
        {tab === "agents" && <AgentsTab ticket={ticket} onOpen={openSubagent} />}
        {openAgent &&
          (openedTask ? (
            <TaskView key={openAgent} ticket={ticket} subagentId={openAgent} onBack={() => setTab("agents")} />
          ) : (
            <SubagentView key={openAgent} ticket={ticket} subagentId={openAgent} onBack={() => setTab("agents")} onOpen={openSubagent} />
          ))}
        {tab === "browser" && <BrowserView sessionId={ticket.sessionId} />}
        {tab === "details" && <TicketDetails ticket={ticket} related={related} />}
        {activePlugin && <PluginFrame key={`${ticket.key}/${tab}`} ticket={ticket} tab={activePlugin} />}
        {wantPlugin && !pluginTabs && (
          <div className="empty" style={{ flex: 1 }}>
            <div className="spinner" />
          </div>
        )}
        </FileLinkScope>
      </div>
      <MessageComposer ticket={ticket} key={ticket.id} />
    </aside>
  );
}

function DetailHeader({
  paneId,
  owner,
  ticket,
  onClose,
  zoomed,
  onToggleZoom,
  onOpenChildren,
}: {
  paneId: string;
  /** The pane's command area: the actions below are also palette commands (never bare keys). */
  owner: string;
  ticket: Ticket;
  onClose: () => void;
  zoomed: boolean;
  onToggleZoom: () => void;
  onOpenChildren: () => void;
}) {
  const { state, client } = useStore();
  const openTicket = useOpenTicket();
  const popout = usePopout();
  const act = useAction();
  const [changes, setChanges] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [sheet, setSheet] = useState<LandSheetState | null>(null);
  const children = isConductor(ticket) ? childrenOf(state, ticket.id) : [];
  const progress = progressOf(children);
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const project = state.projects[ticket.projectId];
  const k = ticket.key;
  // What confirms and toasts call it: "MH-62 · MH-124" for a linked ticket (its remote ID first).
  const label = keyLabel(ticket);

  const remove = async () => {
    if (!confirm(`Delete ${label}? Its transcript and summaries are removed too.`)) return;
    const ok = await act(() => client.deleteTicket(k), `${label} deleted`);
    if (ok) onClose();
  };
  // Each action the buttons offer, when it applies to the ticket as it is now. The buttons and the
  // ⌘K palette (these are its "Actions" commands) run the same functions.
  const start = () => act(() => client.startTicket(k));
  // How the approved work lands: the Approve split button (state/approveMenu.ts). Approving lands
  // it once both reviews pass; there's no separate Complete step.
  // The base branch decides whether merge and pr apply: a ticket on its base branch only cleans up.
  const base = resolveBaseBranch(ticket, project, state.settings, parent).branch;
  const land = landMenu(ticket, project, parent, base);
  // A child's conductor acts as its human reviewer and lands it, so its Approve is off.
  const conductor = managingConductor(ticket, parent);
  const managedReason = conductor && conductorManagedReason(conductor);
  const approveWith = (action: CompletionAction, instructions?: string) => act(() => client.humanReview(k, { decision: "approve", action, ...(instructions ? { instructions } : {}) }), "Approved");
  const approveNoAction = () => act(() => client.completeTicket(k, { skipAgent: true }), `${label} approved, no action taken`);
  const choose = (c: LandChoice) => {
    if (c.kind === "none") return void approveNoAction();
    if (c.kind === "sheet") return setSheet({ action: c.action, required: c.required });
    void approveWith(c.action);
  };
  const approve = () => choose(land.primary);
  const rerunReview = () => act(() => client.rerunAgentReview(k), "Agent review queued");
  const cancelRun = () => act(() => client.cancelTicket(k), "Run cancelled");
  const markDone = () => act(() => client.completeTicket(k, { skipAgent: true }), `${label} marked done`);
  const copyKey = () => void navigator.clipboard.writeText(k);
  const external = ticket.externalRef?.url;
  const reviewing = ticket.status === "review";
  const canApprove = reviewing && ticket.humanReview !== "approved";
  // The Approve split button as the palette names it.
  const landing = !conductor && canApprove && landCommands(land);
  const landChoice = (action: CompletionAction) => {
    const c = landing && landing.others[action];
    return c && { label: c.label, run: () => choose(c) };
  };
  useCommands(owner, {
    "ticket.start": ticket.status === "planning" && start,
    "ticket.approve": canApprove && landing && { label: landing.primary, run: approve },
    "ticket.land.merge": landChoice("merge"),
    "ticket.land.pr": landChoice("pr"),
    "ticket.land.cleanup": landChoice("cleanup"),
    "ticket.land.custom": landChoice("custom"),
    "ticket.requestChanges": canApprove && (() => setChanges(true)),
    "ticket.approveNoAction": reviewing && !conductor && { label: land.noAction.label, run: approveNoAction },
    "ticket.rerunReview": reviewing && !ticket.busy && { label: ticket.agentReview === "skipped" ? "Run agent review" : "Re-run agent review", run: rerunReview },
    "ticket.cancelRun": ticket.busy && cancelRun,
    "ticket.markDone": ticket.status !== "done" && markDone,
    "ticket.reopen": ticket.status === "done" && (() => setReopening(true)),
    "ticket.copyKey": copyKey,
    "ticket.openExternal": !!external && (() => void window.harness?.openExternal(external!)),
    "ticket.delete": () => void remove(),
  });

  return (
    <div className="detail-head">
      <div className="view-header detail-titlebar">
        <PaneGrip paneId={paneId} chip={k} label={label} title={ticket.title} />
        <span className="detail-key selectable" title={ticket.externalRef && label !== k ? `Remote ID ${ticket.externalRef.key} · ticket ${k}` : undefined}>
          <TicketKey ticket={ticket} />
        </span>
        <StatusPill status={ticket.status} />
        <ModelBadge model={ticket.model} driver={ticket.driver} />
        <div className="grow" />
        <MenuButton
          trigger={(toggle) => (
            <button className="btn btn-ghost btn-icon" onClick={toggle} title="More">
              <Icon name="more" />
            </button>
          )}
        >
          {(close) => (
            <>
              <button onClick={() => (close(), copyKey())}>
                <Icon name="hash" /> Copy key
              </button>
              {ticket.externalRef?.url && (
                <button onClick={() => (close(), void window.harness?.openExternal(ticket.externalRef!.url!))}>
                  <Icon name="external" /> Open {ticket.externalRef.key}
                </button>
              )}
              {ticket.status !== "done" && ticket.status !== "review" && (
                <button onClick={() => (close(), void markDone())}>
                  <Icon name="check" /> Mark done
                </button>
              )}
              <hr />
              <MovePaneItems paneId={paneId} onDone={close} />
              <button className="danger" onClick={() => (close(), void remove())}>
                <Icon name="trash" /> Delete ticket
              </button>
            </>
          )}
        </MenuButton>
        <PaneWindowButton paneId={paneId} />
        {!popout && (
          <button
            className="btn btn-ghost btn-icon"
            data-testid="pane-zoom"
            aria-pressed={zoomed}
            onClick={onToggleZoom}
            title={zoomed ? `Restore pane (Esc / ${commandKeys("pane.zoom")[0]})` : `Maximize pane${keyHint("pane.zoom")}`}
            aria-label={zoomed ? "Restore pane" : "Maximize pane"}
          >
            <Icon name={zoomed ? "shrink" : "expand"} />
          </button>
        )}
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={onClose} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane">
          <Icon name="x" />
        </button>
      </div>

      <div className="detail-hero">
        {parent && <ParentCrumb parent={parent} onOpen={(key) => openTicket(key, "children")} />}
        <h1 className="detail-title selectable">{ticket.title || "Untitled"}</h1>
        <div className="detail-meta">
          {project && <ProjectKey project={project} />}
          {hasCustomDriver(state, ticket) && <DriverBadge driver={ticket.driver} />}
          <KindBadge ticket={ticket} childCount={children.length} />
          {ticket.branch && (
            <span className="badge badge-outline mono" title={ticket.workdir ?? undefined}>
              <Icon name="branch" />
              {ticket.branch}
            </span>
          )}
          {ticket.pullRequestUrl && (
            <button
              className="badge badge-outline pr-badge"
              data-testid="pr-link"
              title={`Open ${ticket.pullRequestUrl}`}
              onClick={() => void window.harness?.openExternal(ticket.pullRequestUrl!)}
            >
              <Icon name="external" />
              {pullRequestLabel(ticket.pullRequestUrl)}
            </button>
          )}
          {ticket.status === "review" && (
            <>
              <ReviewMark who="agent" state={ticket.agentReview} />
              <ReviewMark who="human" state={ticket.humanReview} />
            </>
          )}
        </div>

        <ConductorProgress progress={progress} onOpen={onOpenChildren} />

        {ticket.pendingApproval && <ApprovalCard key={ticket.pendingApproval.id} ticket={ticket} approval={ticket.pendingApproval} />}

        <div className="actions">
          {ticket.status === "planning" && (
            <button className="btn btn-primary" onClick={start}>
              <Icon name="play" /> Start work
            </button>
          )}
          {/* A conductor's child keeps its (turned off) Approve once approved: the conductor lands it. */}
          {ticket.status === "review" && (ticket.humanReview !== "approved" || conductor) && (
            <LandButton menu={land} locked={!!conductor} title={managedReason || undefined} onChoose={choose} />
          )}
          {ticket.status === "review" && ticket.humanReview !== "approved" && (
            <button className="btn" onClick={() => setChanges(true)}>
              <Icon name="edit" /> Request changes
            </button>
          )}
          {ticket.status === "review" && (
            <>
              <button className="btn btn-ghost" disabled={ticket.busy} onClick={rerunReview}>
                <Icon name="refresh" /> {ticket.agentReview === "skipped" ? "Run agent review" : "Re-run agent review"}
              </button>
            </>
          )}
          {ticket.status === "done" && (
            <button className="btn" onClick={() => setReopening(true)}>
              <Icon name="refresh" /> Re-open
            </button>
          )}
          {ticket.busy && (
            <button className="btn btn-ghost btn-danger" onClick={cancelRun}>
              <Icon name="stop" /> Cancel run
            </button>
          )}
        </div>
      </div>

      {changes && <RequestChangesModal ticket={ticket} onClose={() => setChanges(false)} />}
      {reopening && <RequestChangesModal reopen ticket={ticket} onClose={() => setReopening(false)} />}
      {sheet && (
        <LandSheet
          key={sheet.action}
          ticket={ticket}
          sheet={sheet}
          onSubmit={(instructions) => approveWith(sheet.action, instructions)}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

/**
 * A pane opened on a remote ID that no local ticket has as its key (a pasted link, a dependency
 * chip, a plugin's navigate): the service found tickets linked to it, so this lists them to open,
 * instead of a dead "not found".
 */
function RemoteIdPane({ paneId, owner, matches, onClose }: { paneId: string; owner: string; matches: RemoteKeyMatches; onClose: () => void }) {
  const { state } = useStore();
  const openTicket = useOpenTicket();
  const list = liveRelatedTickets(state, [matches.requested], matches.relatedTickets);
  return (
    <aside className="detail" {...keysArea("ticket", owner)}>
      <div className="view-header detail-titlebar">
        <PaneGrip paneId={paneId} chip={matches.requested} title="" />
        <span className="detail-key">{matches.requested}</span>
        <div className="grow" />
        <button className="btn btn-ghost btn-icon" onClick={onClose} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane" data-pane-autofocus>
          <Icon name="x" />
        </button>
      </div>
      <div className="empty remote-id-empty" data-testid="remote-id-pane" style={{ flex: 1 }}>
        <Icon name="link" />
        <strong>Remote ID {matches.requested}</strong>
        {list.length === 0
          ? "No ticket is linked to it any more."
          : list.length === 1
            ? "It isn't a ticket key here. This ticket is linked to it:"
            : `It isn't a ticket key here. These ${list.length} tickets are linked to it:`}
        {list.length > 0 && (
          <div className="remote-id-list">
            {list.map((r) => (
              <button key={r.key} className="ticket-link" data-testid="remote-id-ticket" onClick={() => openTicket(r.key)} title={`Open ${r.key}`}>
                <StatusDot status={r.status} />
                <span className="mono">
                  <TicketKey ticket={{ key: r.key, externalRef: { key: r.externalKey } }} />
                </span>
                <span className="truncate">{r.title || "Untitled"}</span>
                {state.projects[r.projectId] && <span className="muted remote-id-project">{state.projects[r.projectId]!.name}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}

/** Notes for the agent that send the ticket back to In progress: request changes (review) or re-open (done). */
function RequestChangesModal({ ticket, onClose, reopen = false }: { ticket: Ticket; onClose: () => void; reopen?: boolean }) {
  const { client } = useStore();
  const act = useAction();
  const [notes, setNotes] = useState("");
  const submit = async () => {
    if (!notes.trim()) return;
    const ok = reopen
      ? await act(() => client.reopenTicket(ticket.key, { notes }), "Re-opened")
      : await act(() => client.humanReview(ticket.key, { decision: "request_changes", notes }), "Changes requested");
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>{reopen ? "Re-open" : "Request changes"}</strong>
        <span className="muted mono">{keyLabel(ticket)}</span>
      </div>
      <div className="modal-body">
        <textarea
          autoFocus
          className="textarea"
          rows={6}
          placeholder={reopen ? "What should the agent do now?" : "What should the agent change?"}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        />
        <div className="field-hint" style={{ marginTop: 6 }}>
          {reopen
            ? "The ticket moves from Done back to In progress and the agent gets your notes. If its worktree was removed, it's recreated."
            : "The ticket moves back to In progress and the agent gets your notes."}
        </div>
      </div>
      <div className="modal-foot">
        <div className="grow" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" disabled={!notes.trim()} onClick={submit}>
          Send to agent <span className="kbd">{MOD}↩</span>
        </button>
      </div>
    </Modal>
  );
}

function Summaries({ ticket }: { ticket: Ticket }) {
  const { state } = useStore();
  const now = useNow();
  const list = state.summaries[ticket.sessionId] ?? [];
  const deps = dependencyStates(state, ticket);
  // Newest is last; open scrolled to it and follow new summaries until the user scrolls up.
  const box = useStickToBottom<HTMLDivElement>();

  return (
    <div className="summaries" ref={box}>
      {ticket.description && (
        <section className="brief">
          <div className="section-title">{ticket.status === "planning" ? "Plan" : "Brief"}</div>
          <Markdown text={ticket.description} />
        </section>
      )}
      {deps.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <span className="section-title">Depends on</span>
          {deps.map((d) => (
            <span key={d.key} className={`chip ${d.state}`} data-dep-state={d.state} title={depChipTitle(d)}>
              {d.done && <Icon name="check" size={9} strokeWidth={3} />}
              {d.ticket ? <TicketKey ticket={d.ticket} /> : d.key}
            </span>
          ))}
        </div>
      )}
      {list.length === 0 ? (
        <div className="empty">
          <Icon name="fileText" />
          <strong>No summaries yet</strong>
          The agent posts short progress updates here as it works.
        </div>
      ) : (
        <ol className="summary-list">
          {list.map((s) => (
            <li key={s.id} className={`summary summary-${s.author}`}>
              <div className="summary-rail">
                <span className="summary-avatar">
                  <Icon name={s.author === "human" ? "user" : s.author === "system" ? "zap" : "sparkle"} size={11} />
                </span>
              </div>
              <div className="summary-main">
                <div className="summary-meta">
                  <strong>{s.author === "agent" ? "Agent" : s.author === "human" ? "You" : "Harness"}</strong>
                  <span className="muted" title={new Date(s.createdAt).toLocaleString()}>
                    {relativeTime(s.createdAt, now)}
                  </span>
                </div>
                <Markdown text={s.body} />
                {/* An older service sends summaries without attachments. */}
                <Attachments list={s.attachments ?? []} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function MessageComposer({ ticket }: { ticket: Ticket }) {
  const { client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => client.ticketFiles(ticket.key, q), [client, ticket.key]);
  const searchCommands = useCallback((q: string) => client.ticketCommands(ticket.key, q), [client, ticket.key]);
  // Off by default and after every send: the ticket stays where it is unless asked to move first.
  const [moveFirst, setMoveFirst] = useState(false);
  const switchLabel = moveSwitchLabel(ticket);
  const move = !!switchLabel && moveFirst;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text]);

  // Focus the reply box when the agent is waiting on an answer.
  useEffect(() => {
    if (ticket.status === "blocked") ref.current?.focus();
  }, [ticket.status]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await act(() => client.sendMessage(ticket.key, body, { move }));
    setSending(false);
    if (ok) {
      setText("");
      setMoveFirst(false);
    }
  };

  return (
    <div className={`composer ${ticket.status === "blocked" ? "attention" : ""}`}>
      <MentionTextarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={COMPOSER_PLACEHOLDER[ticket.status]}
        value={text}
        onValueChange={setText}
        search={searchFiles}
        searchCommands={searchCommands}
        placement="above"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
            // Back to the pane (its current tab); a second Escape then closes the pane as usual.
            e.preventDefault();
            ref.current?.closest(".detail")?.querySelector<HTMLElement>("[data-pane-autofocus]")?.focus();
          }
        }}
      />
      <div className="composer-bar">
        {switchLabel && <Switch checked={move} onChange={setMoveFirst} label={switchLabel} />}
        <span className="muted">{composerHint(ticket, move)}</span>
        <div className="grow" />
        <span className="kbd">{MOD}↩</span>
        <button className="btn btn-primary btn-sm btn-icon" disabled={!text.trim() || sending} onClick={send} title="Send">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
        </button>
      </div>
    </div>
  );
}
