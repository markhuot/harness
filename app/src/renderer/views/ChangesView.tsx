// The Changes tab's body (ChangesTab.tsx loads it lazily, so @pierre/diffs' CodeView and
// @pierre/trees stay out of the main bundle): the ticket's diff against its base, drawn in the app
// instead of the git plugin's iframe. The data still comes from the git plugin's routes
// (/plugins/git/api/{changes,log,file}); what to show and remember is in @harness/shared/state's
// changes.ts, which the plugin's own page shares.
//
// A toolbar (files toggle, branch → base, commits, +/− stats with the viewed count, Unified/Split,
// refresh), the commit list and notices, then a file tree beside one virtualized CodeView of every
// file's diff. Each diff header has a disclosure arrow and a Viewed checkbox; viewed files collapse,
// and a mark lapses when the agent changes that file again. Refreshes on ticket events (debounced),
// every 4 s while the agent works, on a reconnect and when the window comes back.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { parsePatchFiles, resolveTheme, type CodeViewDiffItem, type FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import { themeToTreeStyles, type FileTree as FileTreeModel, type GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { Ticket } from "@harness/shared";
import {
  CHANGES_NARROW_WIDTH,
  changesApi,
  changesEmptyState,
  changesNotices,
  effectiveStyle,
  fileDecoration,
  fingerprint,
  hash,
  isCollapsed,
  plural,
  prune,
  readSidebarCollapsed,
  readStyle,
  readViewed,
  relTime,
  sameMarks,
  saveSidebarCollapsed,
  saveStyle,
  saveViewed,
  type ChangedFile,
  type Changes,
  type ChangesLog,
  type DiffStyle,
  type Viewed,
} from "@harness/shared/state";
import { treeStylesFor } from "@harness/shared/themes";
import { Icon } from "../components/Icon";
import { useStore } from "../state/store";
import { markSyntaxThemeFailed, useSyntaxTheme } from "../state/syntax";
import "./changes.css";

/** Ticket events come in bursts; refresh once they settle. */
const EVENT_DEBOUNCE_MS = 600;
/** File edits don't emit ticket events, so poll while the agent works. */
const BUSY_POLL_MS = 4000;

// The pane's own background rather than the Shiki theme's, like the file pane; the add / delete
// tints mix from it.
const SURFACE = ":host { --diffs-light-bg: var(--bg); --diffs-dark-bg: var(--bg); }";

const ITEM = "diff:";
const itemId = (path: string) => `${ITEM}${path}`;
const pathOf = (id: string) => id.slice(ITEM.length);

type Toggle = { fp: string; collapsed: boolean };

interface Data {
  changes: Changes | null;
  log: ChangesLog | null;
  /** The last refresh's error; the previous data stays on screen with a notice */
  error: string | null;
}

/** The ticket's changes and commits, refetched as described above. */
function useChanges(ticket: Ticket) {
  const { client, epoch } = useStore();
  const key = ticket.key;
  const [data, setData] = useState<Data>({ changes: null, log: null, error: null });
  const [loading, setLoading] = useState(false);
  const run = useRef({ inflight: false, queued: false, live: true });

  const refresh = useCallback(async () => {
    const r = run.current;
    if (r.inflight) {
      r.queued = true;
      return;
    }
    r.inflight = true;
    setLoading(true);
    try {
      const [changes, log] = await Promise.all([client.request<Changes>("GET", changesApi.changes(key)), client.request<ChangesLog>("GET", changesApi.log(key))]);
      if (r.live) setData({ changes, log, error: null });
    } catch (e) {
      if (r.live) setData((d) => ({ ...d, error: (e as Error).message || String(e) }));
    } finally {
      r.inflight = false;
      if (r.live) setLoading(false);
    }
    if (r.queued && r.live) {
      r.queued = false;
      void refresh();
    }
  }, [client, key]);

  useEffect(() => {
    run.current.live = true;
    return () => void (run.current.live = false);
  }, []);
  // First load, and again after a reconnect.
  useEffect(() => void refresh(), [refresh, epoch]);
  // Every change to the ticket (a new object in the store), once the burst settles.
  const seen = useRef(ticket);
  useEffect(() => {
    if (seen.current === ticket) return;
    seen.current = ticket;
    const t = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [ticket, refresh]);
  useEffect(() => {
    if (!ticket.busy) return;
    const t = setInterval(() => document.visibilityState === "visible" && void refresh(), BUSY_POLL_MS);
    return () => clearInterval(t);
  }, [ticket.busy, refresh]);
  useEffect(() => {
    const on = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, [refresh]);

  return { ...data, loading, refresh };
}

/** The element's width, kept current. */
function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export default function ChangesView({ ticket }: { ticket: Ticket }) {
  const { client } = useStore();
  const key = ticket.key;
  const { changes, log, error, loading, refresh } = useChanges(ticket);
  const syntax = useSyntaxTheme();

  const rootRef = useRef<HTMLDivElement>(null);
  const width = useWidth(rootRef);
  const narrow = width > 0 && width < CHANGES_NARROW_WIDTH;
  const [chosenStyle, setChosenStyle] = useState<DiffStyle | null>(() => readStyle());
  const diffStyle = effectiveStyle(chosenStyle, width);
  const [showCommits, setShowCommits] = useState(false);
  /** Narrow: whether the file overlay is open. Wide: whether the docked sidebar is collapsed (remembered). */
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readSidebarCollapsed());
  const filesShown = narrow ? overlayOpen : !sidebarCollapsed;

  // --- the parsed diff, its fingerprints and the viewed marks ------------------------------------
  const patch = changes?.files.length ? changes.patch : "";
  const baseSha = changes?.baseSha ?? null;
  const parsed = useMemo(() => {
    if (!patch) return null;
    const patchKey = `${baseSha}:${patch.length}:${hash(patch)}`;
    const files = parsePatchFiles(patch, `p${patchKey}`).flatMap((p) => p.files);
    return { patchKey, files, fps: new Map(files.map((d) => [d.name, fingerprint(d)])) };
  }, [patch, baseSha]);
  const fps = parsed?.fps;

  const [viewed, setViewed] = useState<Viewed>(() => readViewed(key));
  /** This session's disclosure-arrow toggles, for the version of the diff they were made on */
  const [toggles, setToggles] = useState<ReadonlyMap<string, Toggle>>(new Map());
  // A new diff: marks for files whose diff changed (or that aren't changed any more) lapse, and so do
  // toggles made on an older version of a file.
  useEffect(() => {
    if (!parsed || !changes) return;
    const next = prune(viewed, parsed.fps, new Set(changes.files.map((f) => f.path)));
    if (!sameMarks(next, viewed)) {
      saveViewed(key, next);
      setViewed(next);
    }
    if ([...toggles].some(([p, t]) => parsed.fps.get(p) !== t.fp)) setToggles(new Map([...toggles].filter(([p, t]) => parsed.fps.get(p) === t.fp)));
  }, [parsed]);

  const isViewed = (path: string) => {
    const fp = fps?.get(path);
    return fp !== undefined && viewed.get(path) === fp;
  };
  const collapsedOf = (path: string) => {
    const fp = fps?.get(path);
    return fp !== undefined && isCollapsed(isViewed(path), toggles.get(path), fp);
  };
  const viewedCount = fps ? [...fps.keys()].filter(isViewed).length : 0;

  // Items keep their identity (and version) while a file's diff and collapse don't change, so the
  // viewer only redraws the files that did; it requires a new version to update one.
  const items = useRef(new Map<string, { item: CodeViewDiffItem; fp: string }>());
  const version = useRef(0);
  const list = useMemo(() => {
    if (!parsed) return [];
    const prev = items.current;
    const next = new Map<string, { item: CodeViewDiffItem; fp: string }>();
    const out = parsed.files.map((fileDiff) => {
      const id = itemId(fileDiff.name);
      const fp = parsed.fps.get(fileDiff.name)!;
      const collapsed = collapsedOf(fileDiff.name);
      const old = prev.get(id);
      const item: CodeViewDiffItem = old && old.fp === fp && !!old.item.collapsed === collapsed ? old.item : { id, type: "diff", fileDiff, collapsed, version: ++version.current };
      next.set(id, { item, fp });
      return item;
    });
    items.current = next;
    return out;
  }, [parsed, viewed, toggles]);

  // --- the viewer --------------------------------------------------------------------------------
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  /** A file that just collapsed from partway down: bring its header back to the top once it's redrawn. */
  const reveal = useRef<string | null>(null);
  useLayoutEffect(() => {
    const id = reveal.current;
    reveal.current = null;
    if (id) viewer.current?.scrollTo({ type: "item", id, align: "start", behavior: "instant" });
  }, [list]);
  const willCollapse = (path: string) => {
    const top = viewer.current?.getInstance()?.getTopForItem(itemId(path));
    if (top !== undefined && scroller.current && top < scroller.current.scrollTop) reveal.current = itemId(path);
  };

  const setFileViewed = (path: string, on: boolean) => {
    const fp = fps?.get(path);
    if (fp === undefined) return;
    if (on && !collapsedOf(path)) willCollapse(path);
    const next = new Map(viewed);
    next.delete(path); // re-adding moves it to the end, which is what storage keeps when capped
    if (on) next.set(path, fp);
    saveViewed(key, next);
    setViewed(next);
    // Viewing collapses and unviewing expands, whatever the arrow said.
    if (toggles.has(path)) setToggles(new Map([...toggles].filter(([p]) => p !== path)));
  };
  const toggleCollapsed = (path: string) => {
    const fp = fps?.get(path);
    if (fp === undefined) return;
    const collapsed = !collapsedOf(path);
    if (collapsed) willCollapse(path);
    setToggles(new Map(toggles).set(path, { fp, collapsed }));
  };

  // Context expansion ("N unmodified lines") needs both whole files.
  const current = useRef({ changes, patchKey: parsed?.patchKey ?? "" });
  current.current = { changes, patchKey: parsed?.patchKey ?? "" };
  const loadFiles = useCallback(
    async (d: FileDiffMetadata) => {
      const { changes: c, patchKey } = current.current;
      const get = async (side: "old" | "new", path: string) => (await client.request<{ contents: string | null }>("GET", changesApi.file(key, side, path, c?.baseSha))).contents ?? "";
      const newFile = { name: d.name, contents: await get("new", d.name), cacheKey: `new:${d.name}:${patchKey}` };
      if (d.type === "rename-pure") return { oldFile: null, newFile };
      const oldName = d.prevName ?? d.name;
      return { oldFile: { name: oldName, contents: await get("old", oldName), cacheKey: `old:${c?.baseSha}:${oldName}` }, newFile };
    },
    [client, key],
  );
  const options = useMemo(
    () =>
      ({
        theme: syntax.theme,
        themeType: syntax.themeType,
        diffStyle,
        stickyHeaders: true,
        hunkSeparators: "line-info-basic",
        lineDiffType: "word-alt",
        overflow: "scroll",
        unsafeCSS: SURFACE,
        layout: { paddingTop: 12, paddingBottom: 24, gap: 12 },
        loadDiffFiles: loadFiles,
      }) as const,
    [syntax.name, syntax.themeType, diffStyle, loadFiles],
  );

  const pickFile = (path: string) => {
    if (!items.current.has(itemId(path))) return;
    viewer.current?.scrollTo({ type: "item", id: itemId(path), align: "start", behavior: "smooth" });
    if (narrow) setOverlayOpen(false);
  };

  // --- render ------------------------------------------------------------------------------------
  const notices = changesNotices(changes, error);
  const files = changes?.files ?? [];
  const body =
    error && !changes ? (
      <State icon="alert" title="Couldn't load changes" detail={error} />
    ) : !changes ? (
      <State title="Loading changes…" />
    ) : !files.length ? (
      <State icon="check" {...changesEmptyState(changes)} />
    ) : null;

  return (
    <div ref={rootRef} className={`changes ${narrow ? "narrow" : ""} ${narrow && overlayOpen ? "files-open" : ""} ${!narrow && sidebarCollapsed ? "files-collapsed" : ""}`} data-testid="changes">
      <header className="changes-bar">
        {!body && (
          <button
            className={`btn btn-ghost btn-icon changes-files-toggle ${narrow && overlayOpen ? "on" : ""}`}
            title={filesShown ? "Hide files" : "Show files"}
            aria-label="Files"
            aria-expanded={filesShown}
            data-action="files"
            onClick={() => {
              if (narrow) setOverlayOpen((o) => !o);
              else
                setSidebarCollapsed((c) => {
                  saveSidebarCollapsed(!c);
                  return !c;
                });
            }}
          >
            <Icon name="sidebar" />
          </button>
        )}
        <Refs changes={changes} />
        {(changes?.mode === "branch" || changes?.mode === "pinned") && (
          <button className={`changes-chip ${showCommits ? "on" : ""}`} title="Show commits" data-action="commits" disabled={!log?.commits.length} onClick={() => setShowCommits((s) => !s)}>
            <Icon name="commit" size={12} />
            {plural(log?.commits.length ?? 0, "commit")}
            {!!log?.commits.length && <Icon name="chevronDown" size={11} className="changes-chevron" />}
          </button>
        )}
        {changes && files.length > 0 && (
          <span className="changes-stat">
            <span className="add">+{changes.additions}</span>
            <span className="del">−{changes.deletions}</span>
            <span className="muted">across {plural(files.length, "file")}</span>
            {!!fps?.size && (
              <span className="changes-viewed-count" title="Files marked viewed">
                {viewedCount} / {fps.size} viewed
              </span>
            )}
          </span>
        )}
        <div className="grow" />
        <div className="segmented" role="group" aria-label="Diff layout">
          {(["unified", "split"] as const).map((s) => (
            <button
              key={s}
              className={diffStyle === s ? "on" : ""}
              aria-pressed={diffStyle === s}
              data-action={s}
              onClick={() => {
                saveStyle(s);
                setChosenStyle(s);
              }}
            >
              {s === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
        <button className={`btn btn-ghost btn-icon ${loading ? "spinning" : ""}`} title="Refresh" aria-label="Refresh" data-action="refresh" onClick={() => void refresh()}>
          <Icon name="refresh" />
        </button>
      </header>
      {showCommits && !!log?.commits.length && (
        <div className="changes-commits">
          <ol>
            {log.commits.map((c) => (
              <li key={c.sha}>
                <code className="sha" title={c.sha}>
                  {c.shortSha}
                </code>
                <span className="subject">{c.subject}</span>
                <span className="muted" title={new Date(c.date).toLocaleString()}>
                  {c.author} · {relTime(c.date)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {notices.length > 0 && (
        <div className="changes-notice">
          {notices.map((m) => (
            <div key={m}>
              <Icon name="alert" size={13} />
              {m}
            </div>
          ))}
        </div>
      )}
      {body ?? (
        <main className="changes-body">
          <ChangesFiles files={files} isViewed={isViewed} viewed={viewed} syntax={syntax} onPick={pickFile} />
          <CodeView<undefined, undefined>
            ref={viewer}
            containerRef={scroller}
            className="changes-diffs selectable"
            items={list}
            options={options}
            renderHeaderPrefix={(item) => {
              const path = pathOf(item.id);
              const collapsed = collapsedOf(path);
              return (
                <button
                  className="changes-disclosure"
                  type="button"
                  data-path={path}
                  aria-expanded={!collapsed}
                  aria-label={`${collapsed ? "Expand" : "Collapse"} ${path}`}
                  title={collapsed ? "Show diff" : "Hide diff"}
                  onClick={() => toggleCollapsed(path)}
                >
                  <Icon name="chevronRight" size={12} />
                </button>
              );
            }}
            renderHeaderMetadata={(item) => {
              const path = pathOf(item.id);
              const on = isViewed(path);
              return (
                <label className={`changes-viewed ${on ? "on" : ""}`} title="Mark this file as viewed to collapse it" data-path={path}>
                  <input type="checkbox" checked={on} onChange={(e) => setFileViewed(path, e.currentTarget.checked)} />
                  Viewed
                </label>
              );
            }}
          />
        </main>
      )}
    </div>
  );
}

function Refs({ changes: c }: { changes: Changes | null }) {
  const short = (sha: string | null) => sha?.slice(0, 7) ?? null;
  if (!c) return <span className="changes-refs muted">Changes</span>;
  if (c.mode === "workdir")
    return (
      <span className="changes-refs">
        <Icon name="branch" />
        <span className="muted">Uncommitted on</span>
        <code className="ref">{c.branch ?? "HEAD"}</code>
      </span>
    );
  const pinned = c.mode === "pinned";
  return (
    <span className="changes-refs">
      <Icon name="branch" />
      <code className="ref" title={c.head ?? ""}>
        {c.branch ?? (pinned ? short(c.head) : null) ?? "HEAD"}
      </code>
      <span className="arrow">→</span>
      <code className="ref base" title={pinned && c.base ? `${c.base} at ${c.baseSha}` : (c.baseSha ?? "")}>
        {(pinned ? short(c.baseSha) : c.base) ?? "no base"}
      </code>
      {pinned && (
        <span
          className="changes-pinned"
          title={`The worktree is gone, so this is the diff saved while it existed: ${short(c.baseSha)}..${short(c.worktree ?? c.head)}${c.worktree ? " (including changes that were never committed)" : ""}.`}
        >
          Saved
        </span>
      )}
    </span>
  );
}

function State({ icon, title, detail }: { icon?: "alert" | "check"; title: string; detail?: string }) {
  return (
    <div className="empty changes-state">
      {icon ? <Icon name={icon} /> : <div className="spinner" />}
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}

/**
 * The file tree. Mounted once there are files, so the tree starts with them (expanded); later
 * changes reset its paths and git status in place. Decorations show each file's counts and a ✓ once
 * it's viewed, colored from the app theme; the tree's own colors come from the syntax theme.
 */
function ChangesFiles({
  files,
  isViewed,
  viewed,
  syntax,
  onPick,
}: {
  files: ChangedFile[];
  isViewed: (path: string) => boolean;
  viewed: Viewed;
  syntax: ReturnType<typeof useSyntaxTheme>;
  onPick: (path: string) => void;
}) {
  // The tree's callbacks are fixed at creation, so they read the latest of these.
  const latest = useRef({ stats: new Map<string, ChangedFile>(), isViewed, onPick });
  latest.current = { stats: new Map(files.map((f) => [f.path, f])), isViewed, onPick };
  const { model } = useFileTree({
    paths: files.map((f) => f.path),
    gitStatus: files.map((f): GitStatusEntry => ({ path: f.path, status: f.status })),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    search: false,
    renderRowDecoration: ({ item }) => {
      const f = latest.current.stats.get(item.path);
      if (!f || item.kind !== "file") return null;
      const deco = fileDecoration(f);
      const base = deco && { ...deco, parts: deco.parts?.map(({ text, tone }) => ({ text, color: tone && `var(--diff-${tone})` })) };
      if (!latest.current.isViewed(item.path)) return base;
      const check = { text: "✓", color: "var(--accent)" };
      if (!base) return { text: "✓", title: "Viewed", parts: [check] };
      return { text: `✓ ${base.text}`, title: `Viewed · ${base.title}`, parts: [check, { text: " " }, ...(base.parts ?? [{ text: base.text }])] };
    },
    onSelectionChange: (selected) => selected[0] && latest.current.onPick(selected[0]),
  });

  const shown = useRef(files.map((f) => f.path));
  useEffect(() => {
    const paths = files.map((f) => f.path);
    const had = new Set(shown.current);
    if (paths.length !== had.size || paths.some((p) => !had.has(p))) model.resetPaths(paths);
    shown.current = paths;
    model.setGitStatus(files.map((f) => ({ path: f.path, status: f.status })));
  }, [files, model]);
  // Re-run the rows' decorations (the viewed checks). The tree has no call for that, but setting
  // its (unused) composition re-renders it.
  useEffect(() => model.setComposition(undefined), [viewed, files, model]);

  useTreeTheme(model, syntax);
  return (
    <aside className="changes-files">
      <FileTree model={model} className="changes-tree" />
    </aside>
  );
}

const treeThemes = new Map<string, Record<string, string>>();
const failedTreeThemes = new Set<string>();

/** Color the tree from the syntax theme, blended into the sidebar; a theme that won't resolve falls back everywhere. */
function useTreeTheme(model: FileTreeModel, syntax: ReturnType<typeof useSyntaxTheme>) {
  const applied = useRef<string[]>([]);
  useEffect(() => {
    let live = true;
    void treeStylesFor(syntax.appearance, syntax.name, treeThemes, failedTreeThemes, async (n) => themeToTreeStyles(await resolveTheme(n))).then(({ name, styles }) => {
      if (!live) return;
      if (name !== syntax.name) markSyntaxThemeFailed(syntax.name);
      const el = model.getFileTreeContainer();
      if (!el) return;
      for (const k of applied.current) if (!(k in styles)) el.style.removeProperty(k);
      applied.current = Object.keys(styles).filter((k) => k.startsWith("--"));
      for (const k of applied.current) el.style.setProperty(k, styles[k]!);
      el.style.setProperty("--trees-bg-override", "transparent");
      el.style.setProperty("--trees-border-color-override", "transparent");
    });
    return () => void (live = false);
  }, [model, syntax.name, syntax.appearance]);
}
