import { useEffect, useMemo, useRef, useState } from "react";
import type { Ticket, TicketStatus } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { childrenOf, COMPOSER_PLACEHOLDER, composerHint, depChipTitle, dependencyStates, isReady, parsePluginTab, pluginTabRoute, TAB_LABEL, ticketByKey, TICKET_TABS, type TicketTab } from "@harness/shared/state";
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
import { ParentCrumb } from "../components/Conductor";
import { ResizeHandle } from "../components/ResizeHandle";
import { detailBounds, updateLayout, useLayout } from "../state/layout";



const WIDE_KEY = "harness.detailWide";
function readWide() {
  try {
    return localStorage.getItem(WIDE_KEY) === "1";
  } catch {
    return false;
  }
}

export function TicketDetail({ ticketKey }: { ticketKey: string }) {
  const { state, client, dispatch, epoch, route, navigate } = useStore();
  const [missing, setMissing] = useState(false);
  const [wide, setWide] = useState(readWide);
  // Expand = the full width; restoring goes back to the dragged width (layout.detailWidth).
  const { detailWidth } = useLayout();
  const panel = useRef<HTMLElement>(null);
  const setWidthVar = (w: number | null) => {
    if (w === null) panel.current?.style.removeProperty("--detail-width");
    else panel.current?.style.setProperty("--detail-width", `${w}px`);
  };
  const toggleWide = () => {
    setWide((w) => {
      try {
        localStorage.setItem(WIDE_KEY, w ? "0" : "1");
      } catch {}
      return !w;
    });
  };
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
        // An old key (from before a project rename) resolves to the ticket's current key; follow it.
        if (detail.ticket.key !== ticketKey && route.view === "board") navigate({ ...route, ticketKey: detail.ticket.key });
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, ticketKey, epoch]);

  const close = () => navigate({ view: "board", projectId: route.view === "board" ? route.projectId : null, ticketKey: null, tab: "summaries" });
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === "Escape" && !el.closest("input, textarea, .modal, canvas")) close();
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  });

  if (!ticket) {
    return (
      <aside className="detail">
        <div className="view-header">
          <div className="grow" />
          <button className="btn btn-ghost btn-icon" onClick={close}>
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

  const routeTab = route.view === "board" ? route.tab : "summaries";
  const wantPlugin = parsePluginTab(routeTab);
  const activePlugin = wantPlugin ? pluginTabs?.find((t) => t.pluginId === wantPlugin.pluginId && t.id === wantPlugin.tabId) : undefined;
  // A plugin tab that doesn't apply (or no longer exists) falls back to Summaries once tabs are known.
  // Likewise the conductor-only Tickets tab on a plain ticket.
  const tab: TicketTab = (wantPlugin && !activePlugin && pluginTabs) || (routeTab === "children" && ticket.kind !== "conductor") ? "summaries" : routeTab;
  const setTab = (t: TicketTab) => route.view === "board" && navigate({ ...route, tab: t });
  const childCount = ticket.kind === "conductor" ? childrenOf(state, ticket.id).length : 0;

  return (
    <aside
      ref={panel}
      className={`detail ${wide ? "wide" : ""}`}
      style={detailWidth ? ({ "--detail-width": `${detailWidth}px` } as React.CSSProperties) : undefined}
    >
      {!wide && (
        <ResizeHandle
          className="detail-resizer"
          testId="detail-resizer"
          edge="left"
          label="Resize ticket panel"
          target={panel}
          bounds={() => detailBounds(window.innerWidth, panel.current?.parentElement?.clientWidth ?? window.innerWidth)}
          onPreview={setWidthVar}
          onCommit={(w) => updateLayout({ detailWidth: w })}
          onReset={() => {
            setWidthVar(null);
            updateLayout({ detailWidth: null });
          }}
        />
      )}
      <DetailHeader ticket={ticket} onClose={close} wide={wide} onToggleWide={toggleWide} />
      <nav className="tabs">
        {TICKET_TABS.filter((t) => t !== "children" || ticket.kind === "conductor").map((t) => (
          <button key={t} className={`tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)} data-tab={t}>
            {TAB_LABEL[t]}
            {t === "summaries" && (state.summaries[ticket.sessionId]?.length ?? 0) > 0 && <span className="count">{state.summaries[ticket.sessionId]!.length}</span>}
            {t === "children" && childCount > 0 && <span className="count">{childCount}</span>}
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
        {tab === "transcript" && <Transcript sessionId={ticket.sessionId} emptyHint="The agent's conversation will stream in here." />}
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

function DetailHeader({ ticket, onClose, wide, onToggleWide }: { ticket: Ticket; onClose: () => void; wide: boolean; onToggleWide: () => void }) {
  const { state, client, navigate, route } = useStore();
  const act = useAction();
  const [changes, setChanges] = useState(false);
  const [completing, setCompleting] = useState(false);
  const children = ticket.kind === "conductor" ? childrenOf(state, ticket.id) : [];
  const project = state.projects[ticket.projectId];
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const ready = isReady(ticket);
  const k = ticket.key;

  const remove = async () => {
    if (!confirm(`Delete ${k}? Its transcript and summaries are removed too.`)) return;
    const ok = await act(() => client.deleteTicket(k), `${k} deleted`);
    if (ok) navigate({ view: "board", projectId: route.view === "board" ? route.projectId : null, ticketKey: null, tab: "summaries" });
  };

  return (
    <div className="detail-head">
      <div className="view-header detail-titlebar">
        <span className="detail-key selectable">{k}</span>
        <StatusPill status={ticket.status} />
        <ModelBadge model={ticket.model} driver={ticket.driver} />
        {ticket.busy && (
          <span className="working">
            <span className="spinner" /> Working
          </span>
        )}
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
              <button className="danger" onClick={() => (close(), void remove())}>
                <Icon name="trash" /> Delete ticket
              </button>
            </>
          )}
        </MenuButton>
        <button className="btn btn-ghost btn-icon" onClick={onToggleWide} title={wide ? "Show the board" : "Expand to full width"}>
          <Icon name={wide ? "sidebar" : "expand"} />
        </button>
        <button className="btn btn-ghost btn-icon" onClick={onClose} title="Close (Esc)">
          <Icon name="x" />
        </button>
      </div>

      <div className="detail-hero">
        {parent && <ParentCrumb parent={parent} onOpen={(key) => navigate({ view: "board", projectId: route.view === "board" ? route.projectId : null, ticketKey: key, tab: "children" })} />}
        <h1 className="detail-title selectable">{ticket.title || "Untitled"}</h1>
        <div className="detail-meta">
          {project && (
            <span className="badge badge-outline">
              <span className="project-key sm">{project.key.slice(0, 3)}</span>
              {project.name}
            </span>
          )}
          <DriverBadge driver={ticket.driver} />
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
        {!ticket.pendingApproval && ticket.status === "blocked" && ticket.blockedReason && (
          <div className="callout callout-blocked">
            <Icon name="alert" />
            <div>
              <div className="callout-title">The agent needs your input</div>
              <div className="selectable">{ticket.blockedReason}</div>
            </div>
          </div>
        )}

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
          {ticket.busy && (
            <button className="btn btn-ghost btn-danger" onClick={() => act(() => client.cancelTicket(k), "Run cancelled")}>
              <Icon name="stop" /> Cancel run
            </button>
          )}
        </div>
      </div>

      {changes && <RequestChangesModal ticket={ticket} onClose={() => setChanges(false)} />}
      {completing && <CompleteModal ticket={ticket} onClose={() => setCompleting(false)} />}
    </div>
  );
}

function RequestChangesModal({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const [notes, setNotes] = useState("");
  const submit = async () => {
    const ok = await act(() => client.humanReview(ticket.key, { decision: "request_changes", notes }), "Changes requested");
    if (ok) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>Request changes</strong>
        <span className="muted mono">{ticket.key}</span>
      </div>
      <div className="modal-body">
        <textarea
          autoFocus
          className="textarea"
          rows={6}
          placeholder="What should the agent change?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void submit()}
        />
        <div className="field-hint" style={{ marginTop: 6 }}>
          The ticket moves back to In progress and the agent gets your notes.
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
  const box = useRef<HTMLDivElement>(null);
  // Newest is last; open scrolled to it and follow new summaries.
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [list.length]);

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
    const ok = await act(() => client.sendMessage(ticket.key, body));
    setSending(false);
    if (ok) setText("");
  };

  return (
    <div className={`composer ${ticket.status === "blocked" ? "attention" : ""}`}>
      <textarea
        ref={ref}
        rows={1}
        className="composer-input"
        placeholder={COMPOSER_PLACEHOLDER[ticket.status]}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <span className="muted">{composerHint(ticket)}</span>
        <div className="grow" />
        <span className="kbd">{MOD}↩</span>
        <button className="btn btn-primary btn-sm btn-icon" disabled={!text.trim() || sending} onClick={send} title="Send">
          {sending ? <span className="spinner" /> : <Icon name="arrowUp" strokeWidth={2.25} />}
        </button>
      </div>
    </div>
  );
}
