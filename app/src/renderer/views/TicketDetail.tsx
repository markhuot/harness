import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isConductor, type Ticket, type TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import {
  CHAT_PLACEHOLDER,
  chatHint,
  chatModes,
  childrenOf,
  closeChatMode,
  COMPOSER_PLACEHOLDER,
  composerHint,
  depChipTitle,
  dependencyStates,
  effectiveTab,
  hasCustomDriver,
  isChatMode,
  isReady,
  moveSwitchLabel,
  openChatMode,
  parsePluginTab,
  parseSubagentTab,
  pluginTabRoute,
  setChatMode,
  showsAgentsTab,
  subagentsOf,
  subagentTabRoute,
  TAB_LABEL,
  tabStripTab,
  ticketByKey,
  TICKET_TABS,
  type TicketTab,
} from "@harness/shared/state";
import { Icon, isIconName } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ModelBadge } from "../components/ModelSelect";
import { DriverBadge, KindBadge, MenuButton, MOD, Modal, relativeTime, ReviewMark, StatusPill, Switch, useNow } from "../components/bits";
import { Transcript } from "./Transcript";
import { BrowserView } from "./BrowserView";
import { TicketDetails } from "./TicketDetails";
import { ApprovalCard } from "./Approval";
import { PluginFrame, usePluginTabs } from "./PluginTab";
import { ChildrenTab } from "./ChildrenTab";
import { AgentsTab, SubagentView } from "./AgentsTab";
import { ParentCrumb } from "../components/Conductor";
import { ProjectKey } from "../components/ProjectKey";
import { MentionTextarea } from "../components/MentionTextarea";
import { useStickToBottom } from "../components/stickToBottom";
import { useOpenTicket, usePaneScope } from "../components/paneContext";
import { MovePaneItems, PaneGrip } from "../components/paneHeader";
import { closePane, renameTicketKey, setTab as setPaneTab, toggleZoom, updateAllPanes, updatePanes } from "../state/panes";

/** A ticket's pane in the workspace (components/PaneWorkspace.tsx); its key and tab are the pane's content. */
export function TicketDetail({ paneId, ticketKey, tab: paneTab, zoomed }: { paneId: string; ticketKey: string; tab: TicketTab; zoomed: boolean }) {
  const { state, client, dispatch, epoch } = useStore();
  const scope = usePaneScope();
  const [missing, setMissing] = useState(false);
  // By key, or by an old key the service already resolved (the effect below redirects to the new one).
  const ticket = useMemo(() => ticketByKey(state, ticketKey), [state.tickets, state.keyAliases, ticketKey]);
  const pluginTabs = usePluginTabs(ticket);

  // Detail (summaries, runs, session) — refetch on reconnect.
  useEffect(() => {
    let cancelled = false;
    client
      .getTicket(ticketKey)
      .then((detail) => {
        if (cancelled) return;
        dispatch({ type: "detail", detail, requestedKey: ticketKey });
        // An old key (from before a project rename) resolves to the ticket's current key; follow it
        // on every board (another board's panes may have it open under the old key too).
        if (detail.ticket.key !== ticketKey) updateAllPanes((s) => renameTicketKey(s, ticketKey, detail.ticket.key));
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, ticketKey, epoch]);

  // Escape (closing the focused pane, or ending a zoom) is handled by the workspace.
  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));

  if (!ticket) {
    return (
      <aside className="detail">
        <div className="view-header detail-titlebar">
          <PaneGrip paneId={paneId} chip={ticketKey} title="" />
          <span className="detail-key">{ticketKey}</span>
          <div className="grow" />
          <button className="btn btn-ghost btn-icon" onClick={close} title="Close (Esc)" aria-label="Close pane">
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

  const wantPlugin = parsePluginTab(paneTab);
  const activePlugin = wantPlugin ? pluginTabs?.find((t) => t.pluginId === wantPlugin.pluginId && t.id === wantPlugin.tabId) : undefined;
  const subagents = subagentsOf(state, ticket.sessionId);
  // A plugin tab that doesn't apply (or no longer exists) falls back to Summaries once tabs are known.
  // Likewise the conductor-only Tickets tab on a plain ticket, and Agents on a session without sub-agents.
  const tab = effectiveTab(paneTab, { conductor: isConductor(ticket), pluginTabs, subagents });
  const openAgent = parseSubagentTab(tab);
  const stripTab = tabStripTab(tab);
  const setTab = (t: TicketTab) => updatePanes(scope, (s) => setPaneTab(s, paneId, t));
  const openSubagent = (id: string) => setTab(subagentTabRoute(id));
  const childCount = isConductor(ticket) ? childrenOf(state, ticket.id).length : 0;
  const agentsRunning = subagents?.some((a) => a.status === "running") ?? false;

  return (
    <aside className="detail">
      <DetailHeader paneId={paneId} ticket={ticket} onClose={close} zoomed={zoomed} onToggleZoom={zoom} />
      <nav className="tabs">
        {TICKET_TABS.filter((t) => (t !== "children" || isConductor(ticket)) && (t !== "agents" || showsAgentsTab(subagents))).map((t) => (
          <button key={t} className={`tab ${stripTab === t ? "on" : ""}`} onClick={() => setTab(t)} data-tab={t}>
            {TAB_LABEL[t]}
            {t === "summaries" && (state.summaries[ticket.sessionId]?.length ?? 0) > 0 && <span className="count">{state.summaries[ticket.sessionId]!.length}</span>}
            {t === "children" && childCount > 0 && <span className="count">{childCount}</span>}
            {t === "agents" && (subagents?.length ?? 0) > 0 && <span className="count">{subagents!.length}</span>}
            {t === "agents" && agentsRunning && <span className="live-dot" title="A sub-agent is running" />}
            {t === "transcript" && ticket.busy && <span className="live-dot" />}
          </button>
        ))}
        {pluginTabs?.map((p) => {
          const t = pluginTabRoute(p.pluginId, p.id);
          return (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)} title={`${p.title} (plugin: ${p.pluginId})`} data-plugin-tab={t}>
              {p.icon && isIconName(p.icon) && <Icon name={p.icon} size={12} />}
              {p.title}
            </button>
          );
        })}
      </nav>
      <div className="detail-body">
        {tab === "summaries" && <Summaries ticket={ticket} />}
        {tab === "children" && <ChildrenTab ticket={ticket} />}
        {tab === "transcript" && <Transcript sessionId={ticket.sessionId} onOpenSubagent={openSubagent} emptyHint="The agent's conversation will stream in here." />}
        {tab === "agents" && <AgentsTab ticket={ticket} onOpen={openSubagent} />}
        {openAgent && <SubagentView key={openAgent} ticket={ticket} subagentId={openAgent} onBack={() => setTab("agents")} onOpen={openSubagent} />}
        {tab === "browser" && <BrowserView sessionId={ticket.sessionId} />}
        {tab === "details" && <TicketDetails ticket={ticket} />}
        {activePlugin && <PluginFrame key={`${ticket.key}/${tab}`} ticket={ticket} tab={activePlugin} />}
        {wantPlugin && !pluginTabs && (
          <div className="empty" style={{ flex: 1 }}>
            <div className="spinner" />
          </div>
        )}
      </div>
      {ticket.status !== "done" && <MessageComposer ticket={ticket} key={ticket.id} />}
    </aside>
  );
}

function DetailHeader({ paneId, ticket, onClose, zoomed, onToggleZoom }: { paneId: string; ticket: Ticket; onClose: () => void; zoomed: boolean; onToggleZoom: () => void }) {
  const { state, client } = useStore();
  const openTicket = useOpenTicket();
  const act = useAction();
  const [changes, setChanges] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [completing, setCompleting] = useState(false);
  const children = isConductor(ticket) ? childrenOf(state, ticket.id) : [];
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const project = state.projects[ticket.projectId];
  const ready = isReady(ticket);
  const k = ticket.key;

  const remove = async () => {
    if (!confirm(`Delete ${k}? Its transcript and summaries are removed too.`)) return;
    const ok = await act(() => client.deleteTicket(k), `${k} deleted`);
    if (ok) onClose();
  };

  return (
    <div className="detail-head">
      <div className="view-header detail-titlebar">
        <PaneGrip paneId={paneId} chip={k} title={ticket.title} />
        <span className="detail-key selectable">{k}</span>
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
              <button onClick={() => (close(), void navigator.clipboard.writeText(k))}>
                <Icon name="hash" /> Copy key
              </button>
              {ticket.externalRef?.url && (
                <button onClick={() => (close(), void window.harness?.openExternal(ticket.externalRef!.url!))}>
                  <Icon name="external" /> Open {ticket.externalRef.key}
                </button>
              )}
              {ticket.status !== "done" && (
                <button onClick={() => (close(), void act(() => client.completeTicket(k, { skipAgent: true }), `${k} marked done`))}>
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
        <button
          className="btn btn-ghost btn-icon"
          data-testid="pane-zoom"
          aria-pressed={zoomed}
          onClick={onToggleZoom}
          title={zoomed ? "Restore pane (Esc)" : "Maximize pane"}
          aria-label={zoomed ? "Restore pane" : "Maximize pane"}
        >
          <Icon name={zoomed ? "shrink" : "expand"} />
        </button>
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={onClose} title="Close (Esc)" aria-label="Close pane">
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
            <button className="btn btn-primary" onClick={() => act(() => client.startTicket(k))}>
              <Icon name="play" /> Start work
            </button>
          )}
          {ticket.status === "review" && ticket.humanReview !== "approved" && (
            <>
              <button className="btn btn-primary" onClick={() => act(() => client.humanReview(k, { decision: "approve" }), "Approved")}>
                <Icon name="check" strokeWidth={2.25} /> Approve
              </button>
              <button className="btn" onClick={() => setChanges(true)}>
                <Icon name="edit" /> Request changes
              </button>
            </>
          )}
          {ticket.status === "review" && (
            <>
              <button
                className={`btn ${ready ? "btn-primary" : ""}`}
                disabled={!ready || ticket.busy}
                title={!ready ? "Needs both agent and human approval" : ticket.busy ? "An agent run is in progress" : "Finalize: merge, clean up, mark done"}
                onClick={() => setCompleting(true)}
              >
                <Icon name="checkCircle" /> Complete
              </button>
              <button className="btn btn-ghost" disabled={ticket.busy} onClick={() => act(() => client.rerunAgentReview(k), "Agent review queued")}>
                <Icon name="refresh" /> Re-run agent review
              </button>
            </>
          )}
          {ticket.status === "done" && (
            <button className="btn" onClick={() => setReopening(true)}>
              <Icon name="refresh" /> Re-open
            </button>
          )}
          {ticket.busy && (
            <button className="btn btn-ghost btn-danger" onClick={() => act(() => client.cancelTicket(k), "Run cancelled")}>
              <Icon name="stop" /> Cancel run
            </button>
          )}
        </div>
      </div>

      {changes && <RequestChangesModal ticket={ticket} onClose={() => setChanges(false)} />}
      {reopening && <RequestChangesModal reopen ticket={ticket} onClose={() => setReopening(false)} />}
      {completing && <CompleteModal ticket={ticket} onClose={() => setCompleting(false)} />}
    </div>
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
        <span className="muted mono">{ticket.key}</span>
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

function CompleteModal({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const [instructions, setInstructions] = useState("");
  const [skip, setSkip] = useState(false);
  const submit = async () => {
    const ok = await act(
      () => client.completeTicket(ticket.key, skip ? { skipAgent: true } : { instructions: instructions.trim() || undefined }),
      skip ? `${ticket.key} marked done` : "Completion run queued",
    );
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>Complete {ticket.key}</strong>
      </div>
      <div className="modal-body">
        <p className="dim" style={{ marginTop: 0 }}>
          The agent finalizes the work: merges the worktree branch, cleans up, and marks the ticket done.
        </p>
        <textarea
          autoFocus
          className="textarea"
          rows={4}
          disabled={skip}
          placeholder="Optional instructions, e.g. “squash-merge into main and delete the branch”"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        />
        <div style={{ marginTop: 10 }}>
          <Switch checked={skip} onChange={setSkip} label="Just mark it done (no agent run)" />
        </div>
      </div>
      <div className="modal-foot">
        <div className="grow" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={submit}>
          {skip ? "Mark done" : "Complete"} <span className="kbd">{MOD}↩</span>
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
              {d.ticket?.key ?? d.key}
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
  const [chatMode, setChat] = useState(() => isChatMode(chatModes, ticket.key, Date.now()));
  // Closing the ticket starts the chat mode's TTL; re-opening within it picks the chat back up.
  useEffect(() => {
    openChatMode(chatModes, ticket.key, Date.now());
    return () => closeChatMode(chatModes, ticket.key, Date.now());
  }, [ticket.key]);
  const switchLabel = moveSwitchLabel(ticket);
  const chat = !!switchLabel && chatMode;
  const toggleMove = (move: boolean) => {
    setChatMode(chatModes, ticket.key, !move);
    setChat(!move);
  };

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
    const ok = await act(() => client.sendMessage(ticket.key, body, { chat }));
    setSending(false);
    if (ok) setText("");
  };

  return (
    <div className={`composer ${ticket.status === "blocked" && !chat ? "attention" : ""}`}>
      <MentionTextarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={chat ? CHAT_PLACEHOLDER : COMPOSER_PLACEHOLDER[ticket.status]}
        value={text}
        onValueChange={setText}
        search={searchFiles}
        placement="above"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        {switchLabel && <Switch checked={!chat} onChange={toggleMove} label={switchLabel} />}
        <span className="muted">{chat ? chatHint(ticket) : composerHint(ticket)}</span>
        <div className="grow" />
        <span className="kbd">{MOD}↩</span>
        <button className="btn btn-primary btn-sm btn-icon" disabled={!text.trim() || sending} onClick={send} title="Send">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
        </button>
      </div>
    </div>
  );
}
