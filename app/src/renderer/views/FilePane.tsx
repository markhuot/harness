// A file pane: one project or ticket file in full, editable (views/FileViewer.tsx draws it with the
// CodeMirror editor in editor/), opened from a file link in chat (components/Markdown.tsx) or the
// store's openFile. The linked lines are highlighted and scrolled into view, on open and whenever a
// link moves the pane to other lines. Copy link gives a link to the selected lines, else the linked ones.
//
// Save (the header button, Cmd+S) writes the file through the service. With the "Save on blur"
// setting the editor also saves when it loses focus, the window loses focus, or the pane closes or
// shows another file; without it, closing or replacing a pane with unsaved edits asks first.
//
// A file with uncommitted changes (git.dirty, or untracked in a repo) gets a Diff tab against HEAD
// in the merge view. Contents and diff are refetched on window focus, on a reconnect (epoch), when
// the ticket's worktree or branch changes, and with the refresh button; what's on screen stays until
// the new copy arrives, and a clean editor takes it silently while one with edits keeps them.

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { EditorHandle } from "@harness/editor";
import { formatFileLink, type FileDiff, type FileView } from "@harness/shared";
import { ticketByKey } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/bits";
import { usePaneScope, usePopout } from "../components/paneContext";
import { MovePaneItems, PaneGrip, PaneWindowButton } from "../components/paneHeader";
import { ChunkBoundary, retryableLazy } from "../components/lazyRetry";
import { requestClosePane, registerDraftCloser } from "../components/draftClose";
import { closePane, fileRootTicket, paneLabel, setFileView, toggleZoom, updatePanes, type FileContent, type FileTab } from "../state/panes";
import { focusPaneBy } from "../components/paneFocus";
import { useStore } from "../state/store";
import "./file.css";

const viewer = () => import("./FileViewer");
const fileEditor = retryableLazy(() => viewer().then((m) => m.FileEditor));
const fileChanges = retryableLazy(() => viewer().then((m) => m.FileChanges));
const FileEditor = fileEditor.Component;
const FileChanges = fileChanges.Component;

type Failure = { status: number; message: string };
type Fetched<T> = { data: T | null; error: Failure | null; loading: boolean; /** When the request that produced `data` was sent */ at?: number };

const failureOf = (e: unknown): Failure => ({ status: (e as { status?: number }).status ?? 0, message: (e as Error).message || String(e) });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePane({ paneId, content, zoomed }: { paneId: string; content: FileContent; zoomed: boolean }) {
  const { client, state, epoch, toast } = useStore();
  const scope = usePaneScope();
  const { path } = content;
  const ticketKey = fileRootTicket(content);
  const projectId = "projectId" in content.root ? content.root.projectId : null;
  const ticket = ticketKey ? ticketByKey(state, ticketKey) : undefined;
  const project = projectId ? state.projects[projectId] : ticket ? state.projects[ticket.projectId] : undefined;

  // --- fetching ------------------------------------------------------------------------------
  // Bumped by the refresh button and window focus; the other triggers are effect dependencies.
  const [bump, setBump] = useState(0);
  useEffect(() => {
    const onFocus = () => setBump((n) => n + 1);
    addEventListener("focus", onFocus);
    return () => removeEventListener("focus", onFocus);
  }, []);
  const [file, setFile] = useState<Fetched<FileView>>({ data: null, error: null, loading: true });
  const rootKey = ticketKey ? `t:${ticketKey}` : `p:${projectId}`;
  useEffect(() => {
    let live = true;
    setFile((f) => ({ ...f, loading: true }));
    const at = Date.now();
    const req = ticketKey ? client.ticketFile(ticketKey, path) : client.projectFile(projectId!, path);
    req.then(
      (data) => live && setFile({ data, error: null, loading: false, at }),
      (e) => live && setFile({ data: null, error: failureOf(e), loading: false }),
    );
    return () => void (live = false);
  }, [client, rootKey, path, epoch, bump, ticket?.workdir, ticket?.branch]);

  const view = file.data;
  const changed = !!view?.git.repo && (view.git.dirty || view.git.untracked);
  const tab: FileTab = content.tab === "diff" && changed ? "diff" : "file";
  const [diff, setDiff] = useState<Fetched<FileDiff>>({ data: null, error: null, loading: false });
  // One diff per fetched copy of the file, while the Diff tab shows (a 409 outside git can't happen:
  // the tab only exists in a repo).
  useEffect(() => {
    if (tab !== "diff" || !view) return;
    let live = true;
    setDiff((d) => ({ ...d, loading: true }));
    const req = ticketKey ? client.ticketFileDiff(ticketKey, path) : client.projectFileDiff(projectId!, path);
    req.then(
      (data) => live && setDiff({ data, error: null, loading: false }),
      (e) => live && setDiff({ data: null, error: failureOf(e), loading: false }),
    );
    return () => void (live = false);
  }, [client, rootKey, path, tab, view]);

  // --- lines ---------------------------------------------------------------------------------
  const selected = content.startLine ? { start: content.startLine, end: content.endLine ?? content.startLine } : null;

  // --- editing -------------------------------------------------------------------------------
  const saveOnBlur = !!state.settings?.saveOnBlur;
  const saveOnBlurRef = useRef(saveOnBlur);
  saveOnBlurRef.current = saveOnBlur;
  const handle = useRef<EditorHandle | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** When the last save finished: a fetch sent before it may predate the edits and must not replace them. */
  const savedAt = useRef(0);
  /** Set when the user chose to throw the edits away, so closing doesn't save or ask again. */
  const discarded = useRef(false);
  const writing = useRef<Promise<unknown>>(Promise.resolve());
  const writeFile = useCallback(
    (file: { ticketKey: string | null; projectId: string | null; path: string }, contents: string) =>
      file.ticketKey ? client.writeTicketFile(file.ticketKey, file.path, contents) : client.writeProjectFile(file.projectId!, file.path, contents),
    [client],
  );
  const target = { ticketKey, projectId, path: view?.path ?? path };
  const targetRef = useRef(target);
  targetRef.current = target;
  /** Writes the editor's text, one write at a time; true when it's on disk (or there was nothing to write). */
  const save = useCallback((): Promise<boolean> => {
    const h = handle.current;
    if (!h || !h.isDirty()) return Promise.resolve(true);
    const contents = h.getContents();
    const file = targetRef.current;
    const run = writing.current.then(async () => {
      setSaving(true);
      try {
        await writeFile(file, contents);
        savedAt.current = Date.now();
        h.markSaved(contents);
        // The git badge and Diff tab follow what's now on disk.
        setBump((n) => n + 1);
        return true;
      } catch (e) {
        toast(`Couldn't save ${file.path}: ${(e as Error).message}`, "error");
        return false;
      } finally {
        setSaving(false);
      }
    });
    writing.current = run;
    return run;
  }, [writeFile, toast]);
  const saveIfOnBlur = useCallback(() => {
    if (saveOnBlurRef.current) void save();
  }, [save]);
  useEffect(() => {
    addEventListener("blur", saveIfOnBlur);
    return () => removeEventListener("blur", saveIfOnBlur);
  }, [saveIfOnBlur]);
  // A fetched copy replaces a clean editor's text silently; one with edits keeps them (last write wins).
  useEffect(() => {
    const h = handle.current;
    if (!h || file.at === undefined || file.at < savedAt.current || view?.contents == null || view.truncated) return;
    if (!h.isDirty() && h.getContents() !== view.contents) h.setContents(view.contents);
  }, [view]);
  /** The editor is going away: keep its edits (save, or ask) unless they were discarded. */
  const onDispose = useCallback(
    (last: { contents: string; dirty: boolean }) => {
      setDirty(false);
      if (!last.dirty || discarded.current) return;
      const file = targetRef.current;
      const write = () => void writeFile(file, last.contents).catch((e) => toast(`Couldn't save ${file.path}: ${(e as Error).message}`, "error"));
      if (saveOnBlurRef.current || confirm(`Save changes to ${file.path}?`)) write();
    },
    [writeFile, toast],
  );
  const selectedLines = (): { startLine: number; endLine?: number } | null => {
    const sel = handle.current?.view.state.selection.main;
    if (!sel || sel.empty) return null;
    const doc = handle.current!.view.state.doc;
    const startLine = doc.lineAt(sel.from).number;
    const endLine = doc.lineAt(sel.to).number;
    return endLine > startLine ? { startLine, endLine } : { startLine };
  };

  // --- actions -------------------------------------------------------------------------------
  const doClose = useCallback(
    (keyboard: boolean) => {
      discarded.current = true; // whatever it held was dealt with just now
      if (keyboard) focusPaneBy(scope, (s) => closePane(s, paneId));
      else updatePanes(scope, (s) => closePane(s, paneId));
    },
    [scope, paneId],
  );
  // Closing with unsaved edits saves them (save on blur) or asks; every way of closing comes through here.
  const requestClose = (keyboard: boolean) => {
    if (!handle.current?.isDirty()) return doClose(keyboard);
    const label = targetRef.current.path;
    if (saveOnBlurRef.current || confirm(`Save changes to ${label} before closing?`)) return void save().then((ok) => ok && doClose(keyboard));
    if (confirm(`Discard your unsaved changes to ${label}?`)) doClose(keyboard);
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => registerDraftCloser(paneId, (keyboard) => requestCloseRef.current(keyboard)), [paneId]);
  const close = () => requestClosePane(scope, paneId);
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));
  // A pop-out window holds just this pane: nothing to maximize over.
  const popout = usePopout();
  const setTab = (t: FileTab) => {
    updatePanes(scope, (s) => setFileView(s, paneId, { tab: t }));
  };
  const shownPath = view?.path ?? path;
  const absolute = view ? `${view.root.replace(/\/+$/, "")}/${view.path}` : null;
  const linkLines = (): { startLine?: number; endLine?: number } => selectedLines() ?? { startLine: content.startLine, endLine: content.endLine };
  const link = (lines = linkLines()) => formatFileLink({ path: shownPath, ...lines, ...(ticketKey ? { ticketKey } : { projectId: projectId! }) });
  const name = paneLabel(content);
  const dir = shownPath.includes("/") ? shownPath.slice(0, shownPath.lastIndexOf("/") + 1) : "";
  const where = ticketKey ?? project?.name ?? projectId ?? "";

  return (
    <aside className="file-pane" data-file={shownPath}>
      <div className="view-header detail-titlebar file-titlebar">
        <PaneGrip paneId={paneId} chip={name} title={shownPath} />
        <Icon name="fileText" />
        <span className="file-title mono" title={absolute ?? shownPath}>
          {dir && (
            <span className="file-dir">
              <bdi>{dir}</bdi>
            </span>
          )}
          <span className="file-name">{name}</span>
        </span>
        {changed && (
          <span className={`badge ${view!.git.untracked ? "badge-green" : "badge-amber"}`} data-testid="file-git-state" title={view!.git.untracked ? "Not in git yet" : "Uncommitted changes"}>
            {view!.git.untracked ? "untracked" : "modified"}
          </span>
        )}
        {view?.git.ignored && (
          <span className="badge badge-outline" data-testid="file-ignored" title="Ignored by git (.gitignore)">
            ignored
          </span>
        )}
        {dirty && (
          <span className="file-dirty" data-testid="file-dirty" title="Unsaved changes" aria-label="Unsaved changes" />
        )}
        <div className="grow" />
        {where && (
          <span className="file-root truncate" title={view?.root ?? undefined}>
            {where}
          </span>
        )}
        {tab === "file" && view && !view.binary && view.contents !== null && (
          <button className="btn btn-sm" data-testid="file-save" disabled={!dirty || saving} onClick={() => void save()} title="Save (⌘S)">
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button className="btn btn-ghost btn-icon" data-testid="file-refresh" onClick={() => setBump((n) => n + 1)} title="Reload from disk" aria-label="Reload from disk">
          <Icon name="refresh" />
        </button>
        <MenuButton
          trigger={(toggle) => (
            <button className="btn btn-ghost btn-icon" onClick={toggle} title="More">
              <Icon name="more" />
            </button>
          )}
        >
          {(closeMenu) => (
            <>
              <button onClick={() => (closeMenu(), void navigator.clipboard.writeText(shownPath))}>
                <Icon name="copy" /> Copy path
              </button>
              <button onClick={() => (closeMenu(), void navigator.clipboard.writeText(link()))} title={link()}>
                <Icon name="link" /> Copy link{linkLines().startLine ? " to lines" : ""}
              </button>
              {absolute && window.harness && (
                <button onClick={() => (closeMenu(), void window.harness!.revealInFinder(absolute))}>
                  <Icon name="folder" /> Reveal in Finder
                </button>
              )}
              <hr />
              <MovePaneItems paneId={paneId} onDone={closeMenu} />
              <button className="danger" onClick={() => (closeMenu(), close())}>
                <Icon name="x" /> Close file
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
            onClick={zoom}
            title={zoomed ? "Restore pane" : "Maximize pane"}
            aria-label={zoomed ? "Restore pane" : "Maximize pane"}
          >
            <Icon name={zoomed ? "shrink" : "expand"} />
          </button>
        )}
        <button className="btn btn-ghost btn-icon" data-testid="pane-close" onClick={close} title="Close file" aria-label="Close pane">
          <Icon name="x" />
        </button>
      </div>
      {changed && (
        <nav className="tabs file-tabs" role="tablist" aria-label="File tabs">
          {(["file", "diff"] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? "on" : ""}`} role="tab" aria-selected={tab === t} data-tab={t} onClick={() => setTab(t)}>
              {t === "file" ? "File" : "Diff"}
              {t === "diff" && <span className="file-dirty-dot" title="Uncommitted changes" />}
            </button>
          ))}
        </nav>
      )}
      <div className="file-body selectable" data-testid="file-body" data-tab={tab}>
        {file.error ? (
          <FileProblem icon="alert" title={file.error.status === 404 ? `${shownPath} not found` : `Couldn't open ${shownPath}`} detail={file.error.status === 404 ? `There's no such file in ${where || "this project"}.` : file.error.message} />
        ) : !view ? (
          <div className="empty" style={{ flex: 1 }}>
            <div className="spinner" />
          </div>
        ) : tab === "diff" ? (
          diff.error ? (
            <FileProblem icon="alert" title="Couldn't load the diff" detail={diff.error.message} />
          ) : !diff.data ? (
            <div className="empty" style={{ flex: 1 }}>
              <div className="spinner" />
            </div>
          ) : diff.data.tooLarge ? (
            <FileProblem icon="fileText" title="This diff is too large to show" detail="The changes are over 4 MB." />
          ) : !diff.data.patch ? (
            <FileProblem icon="checkCircle" title="No uncommitted changes" detail="The file matches HEAD." />
          ) : (
            <ChunkBoundary lazies={[fileChanges]} fallback={viewerFailed}>
              <Suspense fallback={null}>
                <FileChanges name={view.path} diff={diff.data} />
              </Suspense>
            </ChunkBoundary>
          )
        ) : view.binary ? (
          <FileProblem icon="image" title="Binary file" detail={`${formatSize(view.size)}; it can't be shown as text.`} />
        ) : view.tooLarge || view.contents === null ? (
          <FileProblem icon="fileText" title="This file is too large to show" detail={`${formatSize(view.size)}; the viewer shows files up to 2 MB.`} />
        ) : (
          <>
            {view.truncated && <div className="file-note">The file grew while it was read; this is only its start, so it can't be edited.</div>}
            <ChunkBoundary lazies={[fileEditor]} fallback={viewerFailed}>
              <Suspense fallback={null}>
                <FileEditor
                  key={`${view.root}\u0000${view.path}`}
                  name={view.path}
                  contents={view.contents}
                  range={selected}
                  readOnly={view.truncated}
                  onHandle={(h) => (handle.current = h)}
                  onDirty={setDirty}
                  onSave={() => void save()}
                  onBlur={saveIfOnBlur}
                  onDispose={onDispose}
                />
              </Suspense>
            </ChunkBoundary>
          </>
        )}
      </div>
    </aside>
  );
}

function FileProblem({
  icon,
  title,
  detail,
  onRetry,
  retryLabel = "Try again",
}: {
  icon: "alert" | "fileText" | "image" | "checkCircle";
  title: string;
  detail: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="empty" data-testid="file-problem" style={{ flex: 1 }}>
      <Icon name={icon} />
      <strong>{title}</strong>
      {detail}
      {onRetry && (
        <button className="btn btn-sm" data-testid="file-retry" onClick={onRetry}>
          <Icon name="refresh" /> {retryLabel}
        </button>
      )}
    </div>
  );
}

/**
 * The code viewer's chunk (or the viewer itself) failed: say so in the pane, with a retry. The
 * retry reloads the window: Chromium remembers a failed import() of a URL for the page's life, and
 * the usual cause (the app rebuilt underneath, so the chunk's name changed) needs the new page
 * anyway. The panes are stored, so this one comes back.
 */
const viewerFailed = () => <FileProblem icon="alert" title="Couldn't show this file" detail="The file viewer didn't load." retryLabel="Reload window" onRetry={() => location.reload()} />;
