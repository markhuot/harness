import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { conductorManagedReason, isConductor, keyLabel, managingConductor, MAX_PROMPT_ATTACHMENTS, resolveBaseBranch, type Attachment, type CompletionAction, type RelatedTicket, type RemoteKeyMatches, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { messageDraftSession, unloadMessageDrafts } from "../state/messageDraftSession";
import {
  AGENTS_LIVE_LABEL,
  annotateAttachment,
  attachmentInputs,
  autoStartTitle,
  autoStartWaitingOn,
  restartsAt,
  restartTitle,
  CHANGES_LABEL,
  CHANGES_TAB,
  childrenOf,
  COMPOSER_PLACEHOLDER,
  effectiveTabWithChanges,
  hasCustomDriver,
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
  dependencyStates,
  ticketByKey,
  visibleTabsWithChanges,
  type TicketTab,
} from "@harness/shared/state";
import type { PluginTab as PluginTabRef } from "@harness/shared";
import { Icon, isIconName } from "../components/Icon";
import { FileLinkScope, SpecAttachmentsScope } from "../components/Markdown";
import { AnnotateScope, type AnnotatedAttachment } from "../components/Annotator";
import { ModelBadge } from "../components/ModelSelect";
import { DriverBadge, KindBadge, MenuButton, MOD, Modal, ReviewMark, StatusDot, StatusPill, TicketKey } from "../components/bits";
import { LandButton, LandSheet, type LandSheetState } from "../components/LandButton";
import { landCommands, landMenu, pullRequestLabel, type LandChoice } from "../state/approveMenu";
import { Transcript } from "./Transcript";
import { BrowserView, type BrowserTear } from "./BrowserView";
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
import { useBoardScope, useOpenTicket, usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { dragProps, tabContextMenu } from "../components/paneDrag";
import { ComposerReturnBar, TornMark, TornPlaceholder } from "../components/TornOff";
import { formatRoute } from "../state/route";
import {
  closePane,
  COMPOSER_TAB,
  popoutIdOf,
  renameTicketKey,
  returnTabPane,
  setTab as setPaneTab,
  toggleZoom,
  tornId,
  updateAllPanes,
  updatePanes,
  useTornOffTabs,
  type TabDrag,
  type TornOff,
  type TornTab,
} from "../state/panes";
import { keysArea, useCommands } from "../components/commands";
import { commandKeys } from "../state/keys";
import { liveRelatedTickets, remoteKeyMatches } from "../state/remoteIds";
import { composerCanSend, waitingAnnotation } from "../state/promptAttachmentFiles";
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

/** The j/k/Space/g/G handlers for a pane whose tab body is under `root` (".detail-body"). */
export function scrollCommands(root: () => HTMLElement | null) {
  const scroll = (fn: (el: HTMLElement) => void) => () => {
    const el = scrollerIn(root());
    if (el) fn(el);
  };
  return {
    "ticket.scrollDown": scroll((el) => el.scrollBy({ top: LINE })),
    "ticket.scrollUp": scroll((el) => el.scrollBy({ top: -LINE })),
    "ticket.pageDown": scroll((el) => el.scrollBy({ top: el.clientHeight * 0.9 })),
    "ticket.pageUp": scroll((el) => el.scrollBy({ top: -el.clientHeight * 0.9 })),
    "ticket.top": scroll((el) => el.scrollTo({ top: 0 })),
    "ticket.bottom": scroll((el) => el.scrollTo({ top: el.scrollHeight })),
  };
}

/**
 * `i` from anywhere in a ticket: its composer, wherever it is. There's one per ticket, in its
 * ticket pane or torn off, so the first in this window is it; a composer torn off into a window of
 * its own brings that window forward (its pane focuses the input there: TicketTabPane).
 */
export function focusTicketComposer(ticketKey: string, torn: TornOff | undefined, boardScope: string) {
  const el = document.querySelector<HTMLElement>(`.pane[data-pane-ticket="${CSS.escape(ticketKey)}"] .composer-input`);
  if (el) return el.focus();
  if (torn?.window) {
    const id = popoutIdOf(torn.scope);
    void window.harness?.popout.open({ id, route: formatRoute({ view: "popout", id, fromScope: boardScope }) });
  }
}

/** A tab's name in a placeholder, a drag image or a torn-off pane's header. */
export function tornTabName(tab: TornTab, pluginTabs: PluginTabRef[] | null | undefined): string {
  if (tab === COMPOSER_TAB) return "Message box";
  const t = tabStripTab(tab);
  if (t === CHANGES_TAB) return CHANGES_LABEL;
  const plugin = parsePluginTab(t);
  if (plugin) return pluginTabs?.find((p) => p.pluginId === plugin.pluginId && p.id === plugin.tabId)?.title ?? plugin.tabId;
  return TAB_LABEL[t as keyof typeof TAB_LABEL] ?? t;
}

/**
 * A ticket, loaded for a pane: by key, or by an old key the service already resolved (the pane then
 * follows the new one); its plugin tabs; and the detail's relatedTickets (the Details tab's
 * External row). `missing` is true once it's gone, or the tickets linked to it when the key is a
 * remote ID. Used by the ticket pane and by its torn-off tabs, which work without it.
 */
export function useTicketData(ticketKey: string) {
  const { state, client, dispatch, epoch } = useStore();
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
  // The spec's media (the detail's attachments), so a spec image is annotated by its record; refetched when the spec changes.
  const [specAttachments, setSpecAttachments] = useState<Attachment[] | undefined>(undefined);
  const specRevision = ticket?.specRevision;
  const attachmentsFor = useRef<number | undefined>(undefined);

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
        setSpecAttachments(detail.attachments);
        attachmentsFor.current = detail.ticket.specRevision;
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
  // A new spec revision can show media the detail didn't list yet.
  useEffect(() => {
    if (attachmentsFor.current === undefined || attachmentsFor.current === specRevision) return;
    let cancelled = false;
    client.getTicket(ticketKey).then(
      (detail) => {
        if (cancelled) return;
        attachmentsFor.current = detail.ticket.specRevision;
        setSpecAttachments(detail.attachments);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [client, ticketKey, specRevision]);
  return { ticket, missing, related, pluginTabs, specAttachments };
}

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
  const { state } = useStore();
  const scope = usePaneScope();
  const boardScope = useBoardScope();
  const { ticket, missing, related, pluginTabs, specAttachments } = useTicketData(ticketKey);
  // Which of its tabs (and its composer) are torn off into panes or windows of their own.
  const torn = useTornOffTabs(ticket?.key ?? ticketKey, boardScope);

  // Escape (closing the focused pane, or ending a zoom) is handled by the workspace.
  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));

  // Keyboard: this pane is a "ticket" command area (state/keys.ts). The tabs are the strip's, in
  // order; the scroll keys move whichever scroller the current tab has.
  const owner = `ticket:${paneId}`;
  const asideRef = useRef<HTMLElement>(null);
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
  useCommands(owner, {
    "tab.next": tabs.length > 1 && (() => goTab(nextTab(tabs, tab, 1))),
    "tab.prev": tabs.length > 1 && (() => goTab(nextTab(tabs, tab, -1))),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`tab.${i + 1}`, !!tabs[i] && (() => goTab(tabs[i]!))])),
    "ticket.compose": !!ticket && (() => focusTicketComposer(ticket!.key, torn.get(COMPOSER_TAB), boardScope)),
    ...scrollCommands(() => asideRef.current?.querySelector(".detail-body") ?? null),
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

  const stripTab = tabStripTab(tab);
  const setTab = (t: TicketTab) => updatePanes(scope, (s) => setPaneTab(s, paneId, t));
  const childCount = isConductor(ticket) ? childrenOf(state, ticket.id).length : 0;
  const agentsRunning = subagents?.some((a) => a.status === "running") ?? false;
  // The tab shown, when it's torn off: its body is a placeholder with the way back.
  const tornShown = torn.get(tornId({ tab }));
  const tornComposer = torn.get(COMPOSER_TAB);
  const back = (id: string) => returnTabPane(boardScope, ticket.key, id);
  const tabDrag = (t: TornTab): TabDrag => ({ kind: "tab", ticketKey: ticket.key, tab: t });

  // role=tab props: one tab stop (the current tab, where pane focus lands), the rest by ←/→. Each
  // drags off into a pane of its own (or out of the window), and its menu does the same.
  const tabProps = (on: boolean, t: TicketTab) => ({
    role: "tab",
    "aria-selected": on,
    tabIndex: on ? 0 : -1,
    "data-pane-autofocus": on || undefined,
    title: tabs.indexOf(t) >= 0 && tabs.indexOf(t) < 9 ? `Press ${tabs.indexOf(t) + 1}, or ⇧⌘[ / ⇧⌘] to go through the tabs. Drag off to open it in a pane of its own.` : undefined,
    ...dragProps(tabDrag(t), { chip: keyLabel(ticket), title: ticket.title, tab: tornTabName(t, pluginTabs) }, boardScope),
    onContextMenu: (e: MouseEvent) => void tabContextMenu(e, scope, boardScope, paneId, tabDrag(t), torn.get(tornId({ tab: t }))),
  });
  const mark = (t: TicketTab) => {
    const where = torn.get(tornId({ tab: t }));
    return where && <TornMark torn={where} />;
  };

  return (
    <aside className="detail" ref={asideRef} {...keysArea("ticket", owner)}>
      <DetailHeader paneId={paneId} owner={owner} ticket={ticket} onClose={close} zoomed={zoomed} onToggleZoom={zoom} />
      <nav className="tabs" role="tablist" aria-label="Ticket tabs" onKeyDown={tabKeys}>
        {tabs.filter((t) => !parsePluginTab(t)).map((t) => (
          <button key={t} className={`tab ${stripTab === t ? "on" : ""} ${torn.has(t) ? "torn" : ""}`} onClick={() => setTab(t)} data-tab={t} {...tabProps(stripTab === t, t)}>
            {t === CHANGES_TAB ? CHANGES_LABEL : TAB_LABEL[t as keyof typeof TAB_LABEL]}
            {t === "spec" && (ticket.specRevision ?? 1) > 1 && <span className="count" title="Revisions">{ticket.specRevision}</span>}
            {t === "activity" && (state.activity[ticket.sessionId]?.length ?? 0) > 0 && <span className="count">{state.activity[ticket.sessionId]!.length}</span>}
            {t === "children" && childCount > 0 && <span className="count">{childCount}</span>}
            {t === "agents" && (subagents?.length ?? 0) > 0 && <span className="count">{subagents!.length}</span>}
            {t === "agents" && agentsRunning && <span className="live-dot" title={AGENTS_LIVE_LABEL} />}
            {t === "transcript" && ticket.busy && <span className="live-dot" />}
            {mark(t)}
          </button>
        ))}
        {otherPluginTabs(pluginTabs)?.map((p) => {
          const t = pluginTabRoute(p.pluginId, p.id);
          return (
            <button
              key={t}
              className={`tab ${tab === t ? "on" : ""} ${torn.has(t) ? "torn" : ""}`}
              onClick={() => setTab(t)}
              data-plugin-tab={t}
              {...tabProps(tab === t, t)}
              title={`${p.title} (plugin: ${p.pluginId}). Drag off to open it in a pane of its own.`}
            >
              {p.icon && isIconName(p.icon) && <Icon name={p.icon} size={12} />}
              {p.title}
              {mark(t)}
            </button>
          );
        })}
      </nav>
      <div className="detail-body">
        {tornShown ? (
          <TornPlaceholder name={tornTabName(tab, pluginTabs)} torn={tornShown} onReturn={() => back(tornId({ tab }))} />
        ) : (
          <TicketTabBody
            ticket={ticket}
            tab={tab}
            requested={paneTab}
            pluginTabs={pluginTabs}
            related={related}
            specAttachments={specAttachments}
            setTab={setTab}
            browser={{ tear: { ticketKey: ticket.key, scope, boardScope, paneId, torn } }}
          />
        )}
      </div>
      {tornComposer ? (
        <ComposerReturnBar torn={tornComposer} onReturn={() => back(COMPOSER_TAB)} />
      ) : (
        <MessageComposer
          ticket={ticket}
          key={ticket.id}
          // The Transcript shows what was sent, unless it's torn off (it's on screen there).
          onSent={() => !torn.has("transcript") && setTab(tabAfterSend(tab, true))}
          grip={<ComposerGrip ticket={ticket} scope={scope} boardScope={boardScope} paneId={paneId} />}
        />
      )}
    </aside>
  );
}

/** What a browser in a tab body is: pinned to one browser tab (a torn-off chip), and where its chips tear off to. */
export interface BrowserOpts {
  pinnedTab?: number;
  tear?: BrowserTear;
  onPinnedClosed?: () => void;
  onTitle?: (title: string) => void;
}

/**
 * One tab's body, as the ticket pane shows it and as a torn-off tab's pane does (TicketTabPane):
 * the same components with the same handlers, so everything works the same in both. `tab` is the
 * tab after fallbacks (effectiveTabWithChanges); `requested` the pane's own, for a plugin tab
 * that's still loading. `setTab` moves within the body (Agents ⇄ a sub-agent).
 */
export function TicketTabBody({
  ticket,
  tab,
  requested,
  pluginTabs,
  related,
  specAttachments,
  setTab,
  browser,
}: {
  ticket: Ticket;
  tab: TicketTab;
  requested: TicketTab;
  pluginTabs: PluginTabRef[] | null | undefined;
  related: RelatedTicket[] | undefined;
  /** The spec's media (TicketDetail.attachments), so a spec image is annotated as itself. */
  specAttachments: Attachment[] | undefined;
  setTab: (t: TicketTab) => void;
  browser: BrowserOpts;
}) {
  const { state } = useStore();
  const wantPlugin = parsePluginTab(normalizeChangesTab(requested));
  const activePlugin = wantPlugin ? pluginTabs?.find((t) => t.pluginId === wantPlugin.pluginId && t.id === wantPlugin.tabId) : undefined;
  const openAgent = parseSubagentTab(tab);
  const openedTask = openAgent ? isTask(subagentById(state, ticket.sessionId, openAgent) ?? {}) : false;
  const openSubagent = (id: string) => setTab(subagentTabRoute(id));
  // Annotate anywhere in the tab (a spec image, a prompt attachment, a message's file, the
  // browser) adds the image with its notes to the ticket's composer, wherever it is in this
  // window; one already waiting there has its notes edited in place.
  return (
    <AnnotateScope onAdd={(a) => composerFor(ticket.key).add(a)} annotationOf={(a) => ticketComposers.get(ticket.key)?.annotationOf(a)}>
    <SpecAttachmentsScope attachments={specAttachments}>
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
      {tab === "browser" && <BrowserView key={browser.pinnedTab ?? "all"} sessionId={ticket.sessionId} pinnedTab={browser.pinnedTab} tear={browser.tear} onPinnedClosed={browser.onPinnedClosed} onTitle={browser.onTitle} />}
      {tab === CHANGES_TAB && <ChangesTab ticket={ticket} />}
      {tab === "details" && <TicketDetails ticket={ticket} related={related} />}
      {activePlugin && <PluginFrame key={`${ticket.key}/${tab}`} ticket={ticket} tab={activePlugin} />}
      {wantPlugin && !pluginTabs && (
        <div className="empty" style={{ flex: 1 }}>
          <div className="spinner" />
        </div>
      )}
    </FileLinkScope>
    </SpecAttachmentsScope>
    </AnnotateScope>
  );
}

/** The composer's grip, on its top edge: drags it off into a pane (or window) of its own, like a tab. */
export function ComposerGrip({ ticket, scope, boardScope, paneId }: { ticket: Ticket; scope: string; boardScope: string; paneId: string }) {
  const drag: TabDrag = { kind: "tab", ticketKey: ticket.key, tab: COMPOSER_TAB };
  return (
    <div
      className="composer-grip"
      data-testid="composer-grip"
      title="Drag to put the message box in a pane of its own (or out of the window)"
      {...dragProps(drag, { chip: keyLabel(ticket), title: ticket.title, tab: tornTabName(COMPOSER_TAB, null) }, boardScope)}
      onContextMenu={(e) => void tabContextMenu(e, scope, boardScope, paneId, drag, undefined)}
    >
      <span className="composer-grip-bar" />
    </div>
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
  const { state } = useStore();
  const openTicket = useOpenTicket();
  const popout = usePopout();
  const { k, label, parent, project, land, conductor, managedReason, start, canStart, waitingToStart, choose, rerunReview, cancelRun, markDone, copyKey, remove, setChanges, setReopening, modals } = useTicketActions(
    owner,
    ticket,
    onClose,
  );
  const children = isConductor(ticket) ? childrenOf(state, ticket.id) : [];
  // Stopped on a usage limit: the service restarts it on its own after the limit resets.
  const restart = restartsAt(ticket);

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
          {canStart && (
            <button className="btn btn-primary" onClick={start}>
              <Icon name="play" /> Start work
            </button>
          )}
          {waitingToStart.length > 0 && (
            <button className="btn btn-primary" data-testid="start-waiting" disabled title={autoStartTitle(waitingToStart)}>
              <Icon name="clock" /> Starts automatically
            </button>
          )}
          {restart !== null && (
            <button className="btn btn-primary" data-testid="restart-waiting" disabled title={restartTitle(new Date(restart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}>
              <Icon name="clock" /> Restarts at {new Date(restart).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
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
      {modals}
    </div>
  );
}

/**
 * A ticket's actions (Start work, Approve and the ways to land, Request changes, Cancel run…), as
 * the palette's "Actions" commands of the command area `owner` and as functions for buttons. The
 * ticket pane's header and every torn-off tab's pane register them, so they work from either.
 * `modals` (Request changes, Re-open, the land sheet) goes in the caller's render.
 */
export function useTicketActions(owner: string, ticket: Ticket, onDeleted: () => void) {
  const { state, client } = useStore();
  const act = useAction();
  const [changes, setChanges] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [sheet, setSheet] = useState<LandSheetState | null>(null);
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const project = state.projects[ticket.projectId];
  const k = ticket.key;
  // What confirms and toasts call it: "MH-62 · MH-124" for a linked ticket (its remote ID first).
  const label = keyLabel(ticket);
  const onClose = onDeleted;

  const remove = async () => {
    if (!confirm(`Delete ${label}? Its transcript, spec history and activity are removed too.`)) return;
    const ok = await act(() => client.deleteTicket(k), `${label} deleted`);
    if (ok) onClose();
  };
  // Each action the buttons offer, when it applies to the ticket as it is now. The buttons and the
  // ⌘K palette (these are its "Actions" commands) run the same functions.
  const start = () => act(() => client.startTicket(k));
  // Started while its dependencies were open: it starts on its own once they're done, so there's
  // nothing to start (Start would skip the wait and run it now).
  const waitingToStart = autoStartWaitingOn(ticket, dependencyStates(state, ticket));
  const canStart = ticket.status === "planning" && !waitingToStart.length;
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
    "ticket.start": canStart && start,
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

  const modals = (
    <>
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
    </>
  );
  return { k, label, parent, project, land, conductor, managedReason, start, canStart, waitingToStart, choose, rerunReview, cancelRun, markDone, copyKey, remove, setChanges, setReopening, modals };
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

/** What a ticket's composer offers Annotate: add an image with its notes, and the notes it has on a file already. */
interface ComposerAnnotate {
  add: (a: AnnotatedAttachment) => void;
  annotationOf: (a: Attachment) => Attachment["annotation"];
}

/**
 * Each ticket's composer in this window, by ticket key: there's one per ticket, in its pane or
 * torn off into a pane of its own, and Annotate from any of its tabs adds to it.
 */
const ticketComposers = new Map<string, ComposerAnnotate>();

// A reload or the window closing mid-debounce: every message draft sends what it hasn't yet, as a
// keepalive request (it outlives the page). pagehide covers what beforeunload misses.
addEventListener("beforeunload", () => void unloadMessageDrafts());
addEventListener("pagehide", () => void unloadMessageDrafts());

/** The ticket's composer in this window; torn off into a window of its own, it can't take notes from here. */
function composerFor(ticketKey: string): ComposerAnnotate {
  const c = ticketComposers.get(ticketKey);
  if (!c) throw new Error("The message box is in another window. Bring it back to this one to add notes to your message");
  return c;
}

/**
 * The ticket's composer. Once a message is sent, onSent shows the Transcript, where it and the
 * answer appear. (+) attaches files the way a New session does (pick, or paste an image; drops and
 * ⌘V of files work too); they show above the input until the message goes, and go with it. `grip`
 * (on its top edge) drags it off into a pane of its own; torn off, it fills that pane (`fill`).
 * Annotate (anywhere in the ticket) adds the image here with its notes (metadata on the attachment;
 * the image isn't changed) and focuses the input for the human to say why; annotating a waiting
 * image again edits its notes in place. Send, at the input's right with its shortcut in it (like
 * New session's Start session), sends the files with their notes.
 */
export function MessageComposer({ ticket, onSent, grip, fill = false }: { ticket: Ticket; onSent: () => void; grip?: ReactNode; fill?: boolean }) {
  const { client, dispatch, toast } = useStore();
  const act = useAction();
  const [sending, setSending] = useState(false);
  // The blur reads the newest copy, not the one this render saw.
  const ticketRef = useRef(ticket);
  ticketRef.current = ticket;
  // The text and files live in the ticket's message draft session (state/messageDraftSession.ts):
  // saved to the service as they're typed, and kept across remounts.
  const draft = messageDraftSession(ticket, {
    save: (key, body) => client.saveMessageDraft(key, body),
    upsert: (t) => dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: t } }),
    error: (m) => toast(m, "error"),
    keepalive: (path, body) =>
      void fetch(client.baseUrl + path, {
        method: "PUT",
        keepalive: true,
        headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {}),
  });
  useSyncExternalStore(draft.subscribe, () => draft.version);
  const { text, attachments } = draft.value;
  const setText = (t: string) => draft.edit({ text: t });
  // Another device's edit (or its send) shows here, unless this one is being typed in.
  useEffect(() => draft.sync(ticket.messageDraft), [draft, ticket.messageDraft]);
  // Unmounting with the input focused sends no blur: the draft isn't being typed in anymore.
  useEffect(() => () => draft.focus(false, ticketRef.current.messageDraft), [draft]);
  // Uploads finish after their render: they read and write the latest list.
  const listRef = useRef(attachments);
  listRef.current = attachments;
  const ref = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => client.ticketFiles(ticket.key, q), [client, ticket.key]);
  const searchCommands = useCallback((q: string) => client.ticketCommands(ticket.key, q), [client, ticket.key]);
  // A message while a tool approval waits answers it (as a deny), and the service won't take files with it.
  const approvalPending = !!ticket.pendingApproval;
  const setList = (next: Attachment[]) => {
    listRef.current = next;
    draft.edit({ attachments: next });
  };
  /** Add to message: the notes go on the same attachment (by id) waiting here, or it's added with them. */
  const annotate = (a: AnnotatedAttachment) => {
    const next = annotateAttachment(listRef.current, a.attachment, a.annotation);
    if (next.skipped) throw new Error(`a message takes up to ${MAX_PROMPT_ATTACHMENTS} files`);
    setList(next.list);
    // Before the annotator closes, so the focus stays here: the human writes why.
    ref.current?.focus();
  };
  const annotateRef = useRef<ComposerAnnotate | null>(null);
  annotateRef.current = { add: annotate, annotationOf: (a) => waitingAnnotation(listRef.current, a) };
  // This window's composer for the ticket while it's mounted (in its pane, or torn off into one).
  useEffect(() => {
    const entry: ComposerAnnotate = { add: (a) => annotateRef.current!.add(a), annotationOf: (a) => annotateRef.current!.annotationOf(a) };
    ticketComposers.set(ticket.key, entry);
    return () => {
      if (ticketComposers.get(ticket.key) === entry) ticketComposers.delete(ticket.key);
    };
  }, [ticket.key]);
  const attach = usePromptAttachmentInput({
    target: { get: () => listRef.current, set: setList },
    enabled: !approvalPending,
    what: "a message",
  });
  // One row: (+), the input and Send. The only note it needs goes on Send's tooltip.
  const sendTitle = approvalPending && attachments.length ? "Attachments can go once the approval is answered" : "Send";
  const canSend = composerCanSend({ text, attachments: attachments.length, pending: attach.pending.length, sending, approvalPending });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A torn-off composer's input fills its pane (CSS); one in a ticket grows with its text.
    if (fill) return void (el.style.height = "");
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [text, fill]);

  // Focus the reply box when the agent is waiting on an answer.
  useEffect(() => {
    if (ticket.status === "blocked") ref.current?.focus();
  }, [ticket.status]);

  const send = async () => {
    if (!canSend) return;
    const body = text.trim();
    const files = attachments;
    setSending(true);
    // No draft save may land after the message: the service clears the draft when it goes.
    await draft.beforeSend();
    // Each file carries its notes (Attachment.annotation).
    const ok = await act(() => client.sendMessage(ticket.key, body, files.length ? { attachments: attachmentInputs(files) } : {}));
    setSending(false);
    if (ok) {
      dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: ok } });
      // Only what went: anything attached while it was sending stays for the next message.
      draft.sent(files);
      onSent();
    } else draft.sendFailed();
  };

  // Its own Annotate scope: a waiting image's lightbox annotates it here, also when the composer
  // is torn off into a pane of its own (away from the tabs' scope).
  return (
    <AnnotateScope onAdd={annotate} annotationOf={(a) => waitingAnnotation(listRef.current, a)}>
    <div
      className={`composer ${ticket.status === "blocked" ? "attention" : ""} ${attach.dropping ? "dropping" : ""} ${fill ? "composer-fill" : ""}`}
      data-testid="composer"
      {...attach.dropProps}
    >
      {grip}
      <PromptAttachmentList
        items={attachments}
        onRemove={attach.remove}
        pending={attach.pending}
        annotate={(a) => ({ attachment: a, onAdd: annotate })}
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
          onFocus={() => draft.focus(true, ticket.messageDraft)}
          onBlur={() => draft.focus(false, ticketRef.current.messageDraft)}
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
        <button className="btn btn-primary composer-send" data-testid="composer-send" disabled={!canSend} onClick={send} title={sendTitle} aria-label="Send">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
          <span className="kbd" aria-hidden>
            {MOD}↩
          </span>
        </button>
      </div>
      {attach.dropping && (
        <div className="draft-drop-hint" data-testid="composer-drop-hint" aria-hidden>
          <PaperclipIcon size={18} />
          Drop to attach
        </div>
      )}
    </div>
    </AnnotateScope>
  );
}
