import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { conductorManagedReason, isConductor, keyLabel, managingConductor, MAX_PROMPT_ATTACHMENTS, resolveBaseBranch, type CompletionAction, type MessageAnnotation, type PromptAttachment, type RelatedTicket, type RemoteKeyMatches, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import {
  AGENTS_LIVE_LABEL,
  annotationsWithin,
  CHANGES_LABEL,
  CHANGES_TAB,
  childrenOf,
  COMPOSER_PLACEHOLDER,
  composerHint,
  effectiveTabWithChanges,
  hasCustomDriver,
  moveSwitchLabel,
  nextTab,
  normalizeChangesTab,
  otherPluginTabs,
  parsePluginTab,
  parseSubagentTab,
  pluginTabRoute,
  isTask,
  subagentById,
  subagentsOf,
  subagentTabRoute,
  tabAfterSend,
  TAB_LABEL,
  tabStripTab,
  ticketByKey,
  visibleTabsWithChanges,
  type TicketTab,
} from "@harness/shared/state";
import { Icon, isIconName } from "../components/Icon";
import { FileLinkScope } from "../components/Markdown";
import { AnnotateScope } from "../components/Annotator";
import { carryAnnotations, pendingSource, withAnnotatedImage, type AnnotatedImage, type AnnotatedList, type AnnotatedOriginal } from "../state/annotator";
import { ModelBadge } from "../components/ModelSelect";
import { DriverBadge, KindBadge, MenuButton, MOD, Modal, ReviewMark, StatusDot, StatusPill, Switch, TicketKey } from "../components/bits";
import { LandButton, LandSheet, type LandSheetState } from "../components/LandButton";
import { landCommands, landMenu, pullRequestLabel, type LandChoice } from "../state/approveMenu";
import { Transcript } from "./Transcript";
import { BrowserView } from "./BrowserView";
import { TicketDetails } from "./TicketDetails";
import { SpecTab } from "./SpecTab";
import { ActivityTab } from "./ActivityTab";
import { DraftEditor } from "./DraftEditor";
import { ApprovalCard } from "./Approval";
import { PluginFrame, usePluginTabs } from "./PluginTab";
import { ChangesTab } from "./ChangesTab";
import { ChildrenTab } from "./ChildrenTab";
import { AgentsTab, SubagentView, TaskView } from "./AgentsTab";
import { ParentCrumb } from "../components/Conductor";
import { ProjectKey } from "../components/ProjectKey";
import { MentionTextarea } from "../components/MentionTextarea";
import { useOpenTicket, usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { closePane, renameTicketKey, setTab as setPaneTab, toggleZoom, updateAllPanes, updatePanes } from "../state/panes";
import { keysArea, useCommands } from "../components/commands";
import { commandKeys } from "../state/keys";
import { liveRelatedTickets, remoteKeyMatches } from "../state/remoteIds";
import { composerCanSend } from "../state/promptAttachmentFiles";
import { PaperclipIcon, PromptAttachmentList } from "../components/PromptAttachments";
import { usePromptAttachmentInput } from "../components/usePromptAttachmentInput";

/** What a command's tooltip adds: " (⇧⌘])", or nothing for a command without keys. */
const keyHint = (id: string) => {
  const keys = commandKeys(id);
  return keys.length ? ` (${keys.join(" / ")})` : "";
};

/**
 * The tab body's scroller: the first element inside `root` that scrolls vertically (each tab has
 * its own, e.g. the transcript's or the Activity list). Null for tabs that don't scroll here,
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
}: {
  paneId: string;
  ticketKey: string;
  tab: TicketTab;
  zoomed: boolean;
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

  // Detail (activity, runs, session) — refetch on reconnect.
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
  /** The composer's Add to message, for annotated pictures from anywhere in the ticket. */
  const composerRef = useRef<((image: AnnotatedImage) => void) | null>(null);
  const subagents = ticket ? subagentsOf(state, ticket.sessionId) : null;
  // Changes is built in (ChangesTab.tsx), after Browser and ahead of Details; the git plugin's own
  // tab never shows, and a saved "plugin:git:changes" opens the built-in one.
  const tabs = ticket ? visibleTabsWithChanges({ conductor: isConductor(ticket), workdir: ticket.workdir, subagents, pluginTabs }) : [];
  // A plugin tab that doesn't apply (or no longer exists) falls back to the Spec once tabs are known.
  // Likewise the conductor-only Tickets tab on a plain ticket, Agents on a session without sub-agents,
  // and Changes on a ticket without a diff.
  const tab = ticket ? effectiveTabWithChanges(paneTab, { conductor: isConductor(ticket), workdir: ticket.workdir, pluginTabs, subagents }) : normalizeChangesTab(paneTab);
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

  const wantPlugin = parsePluginTab(normalizeChangesTab(paneTab));
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
      <DetailHeader paneId={paneId} owner={owner} ticket={ticket} onClose={close} zoomed={zoomed} onToggleZoom={zoom} />
      <nav className="tabs" role="tablist" aria-label="Ticket tabs" onKeyDown={tabKeys}>
        {tabs.filter((t) => !parsePluginTab(t)).map((t) => (
          <button key={t} className={`tab ${stripTab === t ? "on" : ""}`} onClick={() => setTab(t)} data-tab={t} {...tabProps(stripTab === t, t)}>
            {t === CHANGES_TAB ? CHANGES_LABEL : TAB_LABEL[t as keyof typeof TAB_LABEL]}
            {t === "spec" && (ticket.specRevision ?? 1) > 1 && <span className="count" title="Revisions">{ticket.specRevision}</span>}
            {t === "activity" && (state.activity[ticket.sessionId]?.length ?? 0) > 0 && <span className="count">{state.activity[ticket.sessionId]!.length}</span>}
            {t === "children" && childCount > 0 && <span className="count">{childCount}</span>}
            {t === "agents" && (subagents?.length ?? 0) > 0 && <span className="count">{subagents!.length}</span>}
            {t === "agents" && agentsRunning && <span className="live-dot" title={AGENTS_LIVE_LABEL} />}
            {t === "transcript" && ticket.busy && <span className="live-dot" />}
          </button>
        ))}
        {otherPluginTabs(pluginTabs)?.map((p) => {
          const t = pluginTabRoute(p.pluginId, p.id);
          return (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)} data-plugin-tab={t} {...tabProps(tab === t, t)} title={`${p.title} (plugin: ${p.pluginId})`}>
              {p.icon && isIconName(p.icon) && <Icon name={p.icon} size={12} />}
              {p.title}
            </button>
          );
        })}
      </nav>
      {/* Annotate anywhere in the ticket (a spec image, a prompt attachment, a message's file, the
          browser) adds the picture to the composer's message; the composer's own files are replaced in place. */}
      <AnnotateScope onAdd={(image) => composerRef.current?.(image)}>
      <div className="detail-body">
        <FileLinkScope ticketKey={ticket.key} projectId={ticket.projectId}>
        {tab === "spec" && <SpecTab key={ticket.id} ticket={ticket} />}
        {tab === "activity" && <ActivityTab ticket={ticket} />}
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
        {tab === CHANGES_TAB && <ChangesTab ticket={ticket} />}
        {tab === "details" && <TicketDetails ticket={ticket} related={related} />}
        {activePlugin && <PluginFrame key={`${ticket.key}/${tab}`} ticket={ticket} tab={activePlugin} />}
        {wantPlugin && !pluginTabs && (
          <div className="empty" style={{ flex: 1 }}>
            <div className="spinner" />
          </div>
        )}
        </FileLinkScope>
      </div>
      <MessageComposer ticket={ticket} key={ticket.id} annotateRef={composerRef} onSent={() => setTab(tabAfterSend(tab, true))} />
      </AnnotateScope>
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
}: {
  paneId: string;
  /** The pane's command area: the actions below are also palette commands (never bare keys). */
  owner: string;
  ticket: Ticket;
  onClose: () => void;
  zoomed: boolean;
  onToggleZoom: () => void;
}) {
  const { state, client } = useStore();
  const openTicket = useOpenTicket();
  const popout = usePopout();
  const act = useAction();
  const [changes, setChanges] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [sheet, setSheet] = useState<LandSheetState | null>(null);
  const children = isConductor(ticket) ? childrenOf(state, ticket.id) : [];
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const project = state.projects[ticket.projectId];
  const k = ticket.key;
  // What confirms and toasts call it: "MH-62 · MH-124" for a linked ticket (its remote ID first).
  const label = keyLabel(ticket);

  const remove = async () => {
    if (!confirm(`Delete ${label}? Its transcript, spec history and activity are removed too.`)) return;
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

/**
 * The ticket's composer. Once a message is sent, onSent shows the Transcript, where it and the
 * answer appear. (+) attaches files the way a New session does (pick, or paste an image; drops and
 * ⌘V of files work too); they show above the input until the message goes, and go with it.
 * Annotate (anywhere in the ticket) adds the annotated picture here with its notes, and focuses
 * the input for the human to say why; a waiting image can be annotated (again) in place.
 */
function MessageComposer({ ticket, onSent, annotateRef }: { ticket: Ticket; onSent: () => void; annotateRef: { current: ((image: AnnotatedImage) => void) | null } }) {
  const { client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [list, setListState] = useState<AnnotatedList>({ attachments: [], annotations: [] });
  const { attachments, annotations } = list;
  // Uploads finish after their render: they read and write the latest list.
  const listRef = useRef(list);
  listRef.current = list;
  /** What each annotated picture was made from (by its path), to reopen it with its marks. */
  const originals = useRef(new Map<string, AnnotatedOriginal>());
  const ref = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => client.ticketFiles(ticket.key, q), [client, ticket.key]);
  const searchCommands = useCallback((q: string) => client.ticketCommands(ticket.key, q), [client, ticket.key]);
  // Off by default and after every send: the ticket stays where it is unless asked to move first.
  const [moveFirst, setMoveFirst] = useState(false);
  const switchLabel = moveSwitchLabel(ticket);
  const move = !!switchLabel && moveFirst;
  // A message while a tool approval waits answers it (as a deny), and the service won't take files with it.
  const approvalPending = !!ticket.pendingApproval;
  const update = (next: AnnotatedList) => {
    listRef.current = next;
    setListState(next);
    for (const path of originals.current.keys()) if (!next.attachments.some((a) => a.path === path)) originals.current.delete(path);
  };
  /** A new list of files (added, removed, sent): the notes stay on their pictures. */
  const setList = (attachments: PromptAttachment[]) => update({ attachments, annotations: carryAnnotations(listRef.current.attachments, attachments, listRef.current.annotations) });
  /** An annotated picture: in place of the file at `replacePath`, or at the end. */
  const addAnnotated = (image: AnnotatedImage, replacePath: string | null) => {
    const next = withAnnotatedImage(listRef.current, image, replacePath, MAX_PROMPT_ATTACHMENTS);
    if (!next) throw new Error(`a message takes up to ${MAX_PROMPT_ATTACHMENTS} files`);
    originals.current.set(image.attachment.path, image.original);
    update(next);
    // Before the annotator closes, so the focus stays here: the human writes why.
    ref.current?.focus();
  };
  annotateRef.current = (image) => addAnnotated(image, null);
  const attach = usePromptAttachmentInput({
    target: { get: () => listRef.current.attachments, set: setList },
    enabled: !approvalPending,
    what: "a message",
  });
  const hint = approvalPending && attachments.length ? "Attachments can go once the approval is answered" : composerHint(ticket, move);
  const canSend = composerCanSend({ text, attachments: attachments.length, pending: attach.pending.length, sending, approvalPending });

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
    if (!canSend) return;
    const body = text.trim();
    const files = attachments;
    const notes = annotationsWithin(annotations, files.length);
    setSending(true);
    const ok = await act(() => client.sendMessage(ticket.key, body, { move, ...(files.length ? { attachments: files } : {}), ...(notes.length ? { annotations: notes } : {}) }));
    setSending(false);
    if (ok) {
      setText("");
      // Only what went: anything attached while it was sending stays for the next message.
      setList(listRef.current.attachments.filter((a) => !files.includes(a)));
      setMoveFirst(false);
      onSent();
    }
  };

  return (
    <div
      className={`composer ${ticket.status === "blocked" ? "attention" : ""} ${attach.dropping ? "dropping" : ""}`}
      data-testid="composer"
      {...attach.dropProps}
    >
      <PromptAttachmentList
        items={attachments}
        ticketKey={null}
        onRemove={attach.remove}
        pending={attach.pending}
        annotations={annotations}
        annotate={(index, a) => ({
          source: pendingSource(annotations, index, a),
          original: originals.current.get(a.path),
          onAdd: (image) => addAnnotated(image, a.path),
        })}
      />
      <div className="composer-row">
        {!approvalPending && (
          <MenuButton
            align="left"
            trigger={(toggle, open) => (
              <button
                type="button"
                className="btn btn-ghost btn-icon composer-attach"
                data-testid="composer-attach"
                aria-expanded={open}
                onClick={toggle}
                title="Attach files (or drop them here, or paste an image)"
                aria-label="Attach"
              >
                <Icon name="plus" size={16} strokeWidth={2} />
              </button>
            )}
          >
            {(closeMenu) => (
              <>
                <button data-testid="composer-attach-files" onClick={() => (closeMenu(), attach.pickFiles())}>
                  <PaperclipIcon /> Choose files…
                </button>
                <button data-testid="composer-attach-paste" onClick={() => (closeMenu(), void attach.pasteFromClipboard())}>
                  <Icon name="image" /> Paste image
                </button>
              </>
            )}
          </MenuButton>
        )}
        <input ref={attach.fileInput} type="file" multiple hidden data-testid="composer-attach-input" onChange={attach.onFilesPicked} />
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
          onPaste={attach.onPaste}
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
      </div>
      <div className="composer-bar">
        {switchLabel && <Switch checked={move} onChange={setMoveFirst} label={switchLabel} />}
        {hint && (
          <span className="muted" data-testid="composer-hint">
            {hint}
          </span>
        )}
        <div className="grow" />
        <span className="kbd">{MOD}↩</span>
        <button className="btn btn-primary btn-sm btn-icon" data-testid="composer-send" disabled={!canSend} onClick={send} title="Send">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
        </button>
      </div>
      {attach.dropping && (
        <div className="draft-drop-hint" data-testid="composer-drop-hint" aria-hidden>
          <PaperclipIcon size={18} />
          Drop to attach
        </div>
      )}
    </div>
  );
}
