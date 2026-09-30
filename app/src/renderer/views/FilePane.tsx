// A file pane: one project or ticket file in full (views/FileViewer.tsx draws it with @pierre/diffs),
// opened from a file link in chat (components/Markdown.tsx) or the store's openFile. The linked
// lines are highlighted and scrolled into view, on open and whenever a link moves the pane to
// other lines; clicking or dragging line numbers picks lines too (without scrolling), so Copy link
// gives a link to exactly what's highlighted.
//
// A file with uncommitted changes (git.dirty, or untracked in a repo) gets a Diff tab against HEAD.
// Contents and diff are refetched on window focus, on a reconnect (epoch), when the ticket's
// worktree or branch changes, and with the refresh button; what's on screen stays until the new
// copy arrives.

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatFileLink, type FileDiff, type FileView } from "@harness/shared";
import { ticketByKey } from "@harness/shared/state";
import { Icon } from "../components/Icon";
import { MenuButton } from "../components/bits";
import { usePaneScope } from "../components/paneContext";
import { MovePaneItems, PaneGrip } from "../components/paneHeader";
import { closePane, fileRootTicket, paneLabel, setFileView, toggleZoom, updatePanes, type FileContent, type FileTab } from "../state/panes";
import { useStore } from "../state/store";
import "./file.css";

const viewer = () => import("./FileViewer");
const FileCode = lazy(() => viewer().then((m) => ({ default: m.FileCode })));
const FileChanges = lazy(() => viewer().then((m) => ({ default: m.FileChanges })));

type Failure = { status: number; message: string };
type Fetched<T> = { data: T | null; error: Failure | null; loading: boolean };

const failureOf = (e: unknown): Failure => ({ status: (e as { status?: number }).status ?? 0, message: (e as Error).message || String(e) });

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FilePane({ paneId, content, zoomed }: { paneId: string; content: FileContent; zoomed: boolean }) {
  const { client, state, epoch } = useStore();
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
    const req = ticketKey ? client.ticketFile(ticketKey, path) : client.projectFile(projectId!, path);
    req.then(
      (data) => live && setFile({ data, error: null, loading: false }),
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
  }, [tab, view]);
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");

  // --- lines ---------------------------------------------------------------------------------
  const selected = content.startLine ? { start: content.startLine, end: content.endLine ?? content.startLine } : null;
  const bodyRef = useRef<HTMLDivElement>(null);
  // The range to bring into view once the code has rendered it: set when a link (or opening the
  // pane) asks for lines, not when the user picks them in the gutter.
  const pendingScroll = useRef<{ start: number; end: number } | null>(selected);
  const picked = useRef<string | null>(null);
  const rangeKey = selected ? `${selected.start}-${selected.end}` : "";
  const scrollToPending = useCallback(() => {
    const want = pendingScroll.current;
    const scroller = bodyRef.current;
    if (!want || !scroller) return;
    if (scrollToLines(scroller, want.start, want.end)) pendingScroll.current = null;
  }, []);
  useLayoutEffect(() => {
    if (picked.current === rangeKey) return void (picked.current = null);
    pendingScroll.current = selected;
    scrollToPending();
  }, [rangeKey, path]);
  const shownRange = useRef(rangeKey);
  shownRange.current = rangeKey;
  const onSelect = useCallback(
    (r: { start: number; end: number } | null) => {
      const key = r ? `${r.start}-${r.end}` : "";
      // pierre reports the selection it was given too (a link moving the pane): only a change is a pick.
      if (key === shownRange.current) return;
      picked.current = key;
      updatePanes(scope, (s) => setFileView(s, paneId, { lines: r ? { startLine: r.start, endLine: r.end } : null }));
    },
    [scope, paneId],
  );
  // --- actions -------------------------------------------------------------------------------
  const close = () => updatePanes(scope, (s) => closePane(s, paneId));
  const zoom = () => updatePanes(scope, (s) => toggleZoom(s, paneId));
  const setTab = (t: FileTab) => {
    if (t === "file" && selected) pendingScroll.current = selected;
    updatePanes(scope, (s) => setFileView(s, paneId, { tab: t }));
  };
  const shownPath = view?.path ?? path;
  const absolute = view ? `${view.root.replace(/\/+$/, "")}/${view.path}` : null;
  const link = formatFileLink({ path: shownPath, startLine: content.startLine, endLine: content.endLine, ...(ticketKey ? { ticketKey } : { projectId: projectId! }) });
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
        <div className="grow" />
        {where && (
          <span className="file-root truncate" title={view?.root ?? undefined}>
            {where}
          </span>
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
              <button onClick={() => (closeMenu(), void navigator.clipboard.writeText(link))} title={link}>
                <Icon name="link" /> Copy link{content.startLine ? " to lines" : ""}
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
          <div className="grow" />
          {tab === "diff" && (
            <div className="segmented file-diff-style" role="group" aria-label="Diff layout">
              {(["unified", "split"] as const).map((s) => (
                <button key={s} className={diffStyle === s ? "on" : ""} aria-pressed={diffStyle === s} onClick={() => setDiffStyle(s)}>
                  {s === "unified" ? "Unified" : "Split"}
                </button>
              ))}
            </div>
          )}
        </nav>
      )}
      <div ref={bodyRef} className="file-body selectable" data-testid="file-body" data-tab={tab}>
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
            <Suspense fallback={null}>
              <FileChanges name={view.path} diff={diff.data} diffStyle={diffStyle} />
            </Suspense>
          )
        ) : view.binary ? (
          <FileProblem icon="image" title="Binary file" detail={`${formatSize(view.size)}; it can't be shown as text.`} />
        ) : view.tooLarge || view.contents === null ? (
          <FileProblem icon="fileText" title="This file is too large to show" detail={`${formatSize(view.size)}; the viewer shows files up to 2 MB.`} />
        ) : (
          <>
            {view.truncated && <div className="file-note">The file grew while it was read; this is only its start.</div>}
            <Suspense fallback={null}>
              <FileCode name={view.path} contents={view.contents} selected={selected} onSelect={onSelect} onRendered={scrollToPending} />
            </Suspense>
          </>
        )}
      </div>
    </aside>
  );
}

function FileProblem({ icon, title, detail }: { icon: "alert" | "fileText" | "image" | "checkCircle"; title: string; detail: string }) {
  return (
    <div className="empty" data-testid="file-problem" style={{ flex: 1 }}>
      <Icon name={icon} />
      <strong>{title}</strong>
      {detail}
    </div>
  );
}

/**
 * Scroll `scroller` so lines `start`..`end` of the rendered file sit in view: the whole range
 * centred when it fits, else its first line a little below the top. False while those lines
 * aren't rendered yet (the code is still loading), so the caller tries again after the next render.
 */
function scrollToLines(scroller: HTMLElement, start: number, end: number): boolean {
  const host = scroller.querySelector("diffs-container");
  const doc = host?.shadowRoot ?? host;
  const first = doc?.querySelector<HTMLElement>(`[data-line="${start}"]`);
  if (!first) return false;
  const last = doc!.querySelector<HTMLElement>(`[data-line="${end}"]`) ?? first;
  const box = scroller.getBoundingClientRect();
  const top = first.getBoundingClientRect().top - box.top + scroller.scrollTop;
  const height = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
  const offset = height < box.height * 0.8 ? (box.height - height) / 2 : Math.min(48, box.height / 4);
  scroller.scrollTop = Math.max(0, top - offset);
  return true;
}
