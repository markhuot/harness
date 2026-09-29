// New session, as a pane: the editor for a draft ticket (DESIGN.md "Drafts"). It shows in two
// places, as the same editor: a New session pane (ComposeContent, nothing saved yet) and the pane
// of a draft ticket (TicketDetail renders this while `ticket.draft` is set). The first edit worth
// keeping creates the draft and turns the New session pane into the draft's pane in place; the
// editing session (state/draftSession.ts) outlives that swap, so nothing typed meanwhile is lost.
//
// Top to bottom: the project and Task | Conductor, the prompt (it fills the pane), Options (the
// same TicketSettings rows as a ticket's Details, collapsed to a one-line summary), then Plan first
// (⇧⌘↩) and Start session (⌘↩).

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import type { Project, Ticket, UpdateTicketBody } from "@harness/shared";
import {
  blankDraftTicket,
  composerProject,
  modelCacheFor,
  modelName,
  newSessionOptionsSummary,
  newSessionPlaceholder,
  optionsNeedAttention,
  predictedTicketKey,
  projectDriver,
  sortedProjects,
  ticketBranchHint,
  ticketChoice,
} from "@harness/shared/state";
import { useAction, useStore } from "../state/store";
import { closePane, composeToTicket, findLeaf, getPaneStore, renameTicketKey, setTab, toggleZoom, updateAllPanes, updatePanes, type ComposeContent } from "../state/panes";
import { DraftSession, dropDraftSession, paneDraftSession, releaseDraftSession, unloadDraftSessions, type DraftDeps } from "../state/draftSession";
import { MenuButton, MOD, Modal } from "../components/bits";
import { Icon } from "../components/Icon";
import { MentionTextarea } from "../components/MentionTextarea";
import { ProjectKey } from "../components/ProjectKey";
import { TicketSettings, useCheckoutBranch, useProjectBranches } from "../components/TicketSettings";
import { MovePaneItems, PaneGrip } from "../components/paneHeader";
import { usePaneScope } from "../components/paneContext";
import { registerDraftCloser } from "../components/draftClose";
import { focusPaneBy } from "../components/paneFocus";
import { keysArea, useCommands } from "../components/commands";
import { commandKeys } from "../state/keys";

const LAST_PROJECT = "harness.lastProject";
const ADD_PROJECT = "__add";

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT);
  } catch {
    return null;
  }
}

// A reload or the window closing mid-debounce: every open draft sends what it hasn't yet, as
// keepalive requests (they outlive the page). pagehide covers what beforeunload misses; the second
// finds nothing left to send.
addEventListener("beforeunload", () => void unloadDraftSessions());
addEventListener("pagehide", () => void unloadDraftSessions());

/** Whether pane `leafId` (in any board's panes) still shows the session's draft. */
function paneShows(leafId: string, s: DraftSession): boolean {
  for (const st of Object.values(getPaneStore().scopes)) {
    const leaf = findLeaf(st.root, leafId);
    if (!leaf) continue;
    const c = leaf.content;
    return (c.kind === "compose" && c.id === s.composeId) || (c.kind === "ticket" && !!s.key && c.ticketKey === s.key);
  }
  return false;
}

/**
 * The pane's editing session, kept across remounts: the New session `compose` (once a project is
 * known) or the saved draft `ticket`. Null while a New session has no project to go in.
 */
function useDraftSession(paneId: string, compose: ComposeContent | undefined, ticket: Ticket | undefined, project: Project | undefined, deps: DraftDeps): DraftSession | null {
  const { state } = useStore();
  const session = useMemo(() => {
    if (ticket) return paneDraftSession(paneId, (s) => s.saved?.id === ticket.id, () => new DraftSession(ticket, ticket, deps, null));
    if (!compose || !project) return null;
    const key = predictedTicketKey(project, (k) => !!state.tickets[k]);
    return paneDraftSession(paneId, (s) => s.composeId === compose.id, () => new DraftSession(blankDraftTicket(project, state.settings, key), null, deps, compose.id));
    // A session is made once per pane and draft; later renders only find it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paneId, compose?.id, ticket?.id, !!project]);
  if (session) session.deps = deps;
  useSyncExternalStore(session?.subscribe ?? noSubscribe, () => session?.version ?? 0);
  // The pane stopped showing this draft (closed, or it shows something else now): save what's left.
  useEffect(() => {
    if (!session) return;
    return () => void setTimeout(() => releaseDraftSession(paneId, session, paneShows(paneId, session)));
  }, [paneId, session]);
  return session;
}
const noSubscribe = () => () => {};

export function DraftEditor({ paneId, zoomed, compose, ticket }: { paneId: string; zoomed: boolean; compose?: ComposeContent; ticket?: Ticket }) {
  const { state, client, dispatch, toast, route } = useStore();
  const act = useAction();
  const scope = usePaneScope();
  const stateRef = useRef(state);
  stateRef.current = state;

  const routeProject = route.view === "board" ? route.projectId : null;
  const composeProject = compose ? composerProject(state, compose.projectId ?? "", [routeProject, readLast()]) : "";
  const deps: DraftDeps = {
    client,
    project: (id) => stateRef.current.projects[id],
    settings: () => stateRef.current.settings,
    upsert: (t) => dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: t } }),
    rekeyed: (from, to) => {
      if (from === null && compose) updatePanes(scope, (s) => composeToTicket(s, compose.id, to));
      else if (from) updateAllPanes((s) => renameTicketKey(s, from, to));
    },
    error: (m) => toast(m, "error"),
    keepalive: (method, path, body) =>
      void fetch(client.baseUrl + path, {
        method,
        keepalive: true,
        headers: { authorization: `Bearer ${client.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => {}),
  };
  const session = useDraftSession(paneId, compose, ticket, state.projects[ticket?.projectId ?? composeProject], deps);
  const local = session?.local;
  const project = local ? state.projects[local.projectId] : state.projects[composeProject];

  // The store's copy (another device's edit, or our own save coming back) when nothing is unsent.
  useEffect(() => {
    if (session && ticket) session.receive(ticket);
  }, [session, ticket]);
  // Before the first save the key is a prediction, which moves with the project.
  const predicted = !session?.saved && project ? predictedTicketKey(project, (k) => !!state.tickets[k]) : null;
  useEffect(() => {
    if (predicted) session?.setPredictedKey(predicted);
  }, [session, predicted]);

  const view = local;
  const branches = useProjectBranches(project, view?.requestedBranch ?? null);
  const checkout = useCheckoutBranch(project, branches);
  const hint = view && project && project.isGit !== false ? ticketBranchHint(view, project, state.settings, branches, checkout) : null;
  const attention = !!hint && optionsNeedAttention(hint);
  // Options starts collapsed; a pick that would block (or isn't valid) opens it.
  useEffect(() => {
    if (attention && session && !session.optionsOpen) session.set({ optionsOpen: true });
  }, [attention, session]);

  // Model names for the collapsed summary.
  const cache = modelCacheFor(client);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const choice = view ? ticketChoice(view, project, state.settings) : null;
  useEffect(() => {
    if (choice?.driver) void cache.load(choice.driver);
  }, [cache, choice?.driver]);
  const summary =
    view && project
      ? newSessionOptionsSummary(view, project, state.settings, {
          model: (d, m) => (m ? modelName(cache.get(d).data?.models, m) : null),
          driver: (d) => state.drivers.find((x) => x.id === d)?.name ?? d,
          checkoutName: checkout?.name ?? null,
        })
      : [];

  const promptRef = useRef<HTMLTextAreaElement>(null);
  const searchFiles = useCallback((q: string) => (project ? client.projectFiles(project.id, q) : Promise.resolve([])), [client, project?.id]);

  const close = (keyboard = false) => {
    if (session) dropDraftSession(paneId, session);
    if (keyboard) focusPaneBy(scope, (s) => closePane(s, paneId));
    else updatePanes(scope, (s) => closePane(s, paneId));
  };
  /** Every way of closing this pane comes here (components/draftClose.ts). */
  const requestClose = (keyboard = false) => {
    if (!session) return close(keyboard);
    if (session.busy) return;
    if (session.isEmpty()) {
      // Nothing worth keeping: close, and delete it if it was saved.
      close(keyboard);
      if (session.saved || session.unsent) void session.discard();
      return;
    }
    session.set({ closing: true });
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => registerDraftCloser(paneId, (keyboard) => requestCloseRef.current(keyboard)), [paneId]);

  const saveAndClose = async () => {
    if (!session) return;
    session.set({ closing: false });
    if (await session.flush()) close();
  };
  const discard = async () => {
    if (!session) return;
    session.set({ closing: false });
    if (await session.discard()) {
      close();
      if (session.saved) toast(`${session.saved.key} discarded`, "info");
    }
  };
  const confirmDiscard = () => {
    if (!session) return;
    if (session.local.description.trim() && !confirm(`Discard this draft? ${session.key ?? "It"} is deleted with its prompt and settings.`)) return;
    void discard();
  };

  const canSubmit = !!view && !!project && !!view.description.trim() && hint?.tone !== "error" && !session?.busy;
  const submit = async (start: boolean) => {
    if (!session || !canSubmit) return;
    const t = await session.submit(start);
    if (!t) return;
    try {
      localStorage.setItem(LAST_PROJECT, t.projectId);
    } catch {}
    dropDraftSession(paneId, session);
    updatePanes(scope, (s) => setTab(s, paneId, start ? "transcript" : "summaries"));
  };

  const addProject = async () => {
    const path = await window.harness?.pickDirectory();
    if (!path) return;
    const p = await act(() => client.createProject({ path }));
    if (p) changeProject(p);
    promptRef.current?.focus();
  };
  const changeProject = (next: Project) => {
    if (!session || next.id === session.local.projectId) return;
    const patch: UpdateTicketBody = { projectId: next.id, branch: null, baseBranch: null, useWorktree: null };
    // A draft on its project's default model follows the new project's default.
    const nextDriver = projectDriver(next, state.settings);
    if (ticketChoice(session.local, project, state.settings).driver === null && nextDriver) Object.assign(patch, { driver: nextDriver, model: null });
    session.edit(patch);
  };

  const owner = `draft:${paneId}`;
  useCommands(owner, {
    "ticket.copyKey": !!session?.key && (() => void navigator.clipboard.writeText(session!.key!)),
    "ticket.delete": !!session && confirmDiscard,
  });
  const keys = (e: KeyboardEvent) => {
    if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.altKey) return;
    // ⌘↩ starts, ⇧⌘↩ plans first (before the pane's ⇧⌘↩ zoom gets it).
    e.preventDefault();
    e.stopPropagation();
    void submit(!e.shiftKey);
  };

  const key = session?.key ?? null;
  const projects = sortedProjects(state);
  const optionsOpen = !!session?.optionsOpen;
  const saving = !!session && !!key && session.unsent;

  return (
    <aside className="detail draft-pane" data-testid="draft-pane" data-draft-key={key ?? undefined} {...keysArea("ticket", owner)} onKeyDown={keys}>
      <div className="view-header detail-titlebar draft-titlebar">
        <PaneGrip paneId={paneId} chip={key ?? "New session"} title={view?.title || view?.description.split("\n")[0] || "Draft"} />
        <Icon name="edit" size={13} className="draft-icon" />
        <span className="detail-key draft-title selectable" data-testid="draft-title">
          {key ?? "New session"}
        </span>
        <span className="badge draft-badge">Draft</span>
        <span className="muted draft-saving" aria-live="polite">
          {saving ? "Saving…" : key ? "Saved" : ""}
        </span>
        <div className="grow" />
        <MenuButton
          trigger={(toggle) => (
            <button className="btn btn-ghost btn-icon" onClick={toggle} title="More" data-testid="draft-more">
              <Icon name="more" />
            </button>
          )}
        >
          {(closeMenu) => (
            <>
              {key && (
                <button onClick={() => (closeMenu(), void navigator.clipboard.writeText(key))}>
                  <Icon name="hash" /> Copy key
                </button>
              )}
              <button onClick={() => (closeMenu(), requestClose())}>
                <Icon name="x" /> Close
              </button>
              <hr />
              <MovePaneItems paneId={paneId} onDone={closeMenu} />
              <button className="danger" data-testid="discard-draft" onClick={() => (closeMenu(), confirmDiscard())}>
                <Icon name="trash" /> Discard draft
              </button>
            </>
          )}
        </MenuButton>
        <button
          className="btn btn-ghost btn-icon"
          data-testid="pane-zoom"
          aria-pressed={zoomed}
          onClick={() => updatePanes(scope, (s) => toggleZoom(s, paneId))}
          title={zoomed ? "Restore pane" : "Maximize pane"}
          aria-label={zoomed ? "Restore pane" : "Maximize pane"}
        >
          <Icon name={zoomed ? "shrink" : "expand"} />
        </button>
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={() => requestClose()} title={`Close (Esc / ${commandKeys("pane.close")[0]})`} aria-label="Close pane">
          <Icon name="x" />
        </button>
      </div>

      <div className="draft-body">
        <div className="draft-top">
          <div className="project-picker">
            {project && <ProjectKey project={project} />}
            <select
              className="select bare"
              aria-label="Project"
              value={project?.id ?? ""}
              onChange={(e) => {
                // The last option adds a project; the select stays controlled, so it snaps back until one is added.
                if (e.target.value === ADD_PROJECT) void addProject();
                else if (state.projects[e.target.value]) changeProject(state.projects[e.target.value]!);
              }}
            >
              {projects.length === 0 && <option value="">No projects</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.key})
                </option>
              ))}
              <option value={ADD_PROJECT}>Add project…</option>
            </select>
          </div>
          <div className="grow" />
          <div className="segmented" role="group" aria-label="Kind">
            <button className={view?.kind !== "conductor" ? "on" : ""} aria-pressed={view?.kind !== "conductor"} disabled={!session} onClick={() => session?.edit({ kind: "task" })}>
              Task
            </button>
            <button className={view?.kind === "conductor" ? "on" : ""} aria-pressed={view?.kind === "conductor"} disabled={!session} onClick={() => session?.edit({ kind: "conductor" })} title="Orchestrates child tickets">
              Conductor
            </button>
          </div>
        </div>

        <MentionTextarea
          ref={promptRef}
          autoFocus={!!compose}
          data-pane-autofocus
          className="draft-prompt"
          aria-label="Prompt"
          placeholder={newSessionPlaceholder(view?.kind ?? "task")}
          value={view?.description ?? ""}
          disabled={!session}
          onValueChange={(v) => session?.edit({ description: v })}
          search={searchFiles}
        />

        {view && project && (
          <div className={`draft-options ${optionsOpen ? "open" : ""}`}>
            <button
              type="button"
              className="draft-options-toggle"
              data-testid="draft-options"
              aria-expanded={optionsOpen}
              onClick={() => session?.set({ optionsOpen: !optionsOpen })}
            >
              <Icon name={optionsOpen ? "chevronDown" : "chevronRight"} size={12} />
              <span className="draft-options-label">Options</span>
              {summary.length > 0 && (
                <span className="draft-options-summary truncate" data-testid="draft-options-summary">
                  {summary.join(" · ")}
                </span>
              )}
              {attention && !optionsOpen && <Icon name="alert" size={12} className="draft-options-alert" />}
            </button>
            {optionsOpen && <TicketSettings ticket={view} project={project} onPatch={(p) => session?.edit(p)} />}
          </div>
        )}
      </div>

      <div className="draft-foot">
        <div className="grow" />
        <button className="btn btn-ghost" data-testid="draft-plan" disabled={!canSubmit} onClick={() => void submit(false)} title="Save it in Planning; an agent drafts a plan first">
          Plan first <span className="kbd">⇧{MOD}↩</span>
        </button>
        <button className="btn btn-primary" data-testid="draft-start" disabled={!canSubmit} onClick={() => void submit(true)}>
          {session?.busy ? <span className="spinner" /> : null}
          Start session <span className="kbd">{MOD}↩</span>
        </button>
      </div>

      {session?.closing && <CloseDraftModal draftKey={key} onSave={() => void saveAndClose()} onDiscard={() => void discard()} onCancel={() => session.set({ closing: false })} />}
    </aside>
  );
}

/** "Close this draft?": Save draft (↩), Discard draft, or Cancel (Esc). */
function CloseDraftModal({ draftKey, onSave, onDiscard, onCancel }: { draftKey: string | null; onSave: () => void; onDiscard: () => void; onCancel: () => void }) {
  return (
    <Modal onClose={onCancel} width={420} className="close-draft">
      <div className="modal-head">
        <strong>Close this draft?</strong>
        {draftKey && <span className="muted mono">{draftKey}</span>}
      </div>
      <div className="modal-body">
        <p className="dim" style={{ margin: 0 }}>
          Save it to pick up later from Planning, or discard it.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn btn-ghost btn-danger" data-testid="close-draft-discard" onClick={onDiscard}>
          Discard draft
        </button>
        <div className="grow" />
        <button className="btn btn-ghost" data-testid="close-draft-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary" data-testid="close-draft-save" autoFocus onClick={onSave}>
          Save draft <span className="kbd">↩</span>
        </button>
      </div>
    </Modal>
  );
}
