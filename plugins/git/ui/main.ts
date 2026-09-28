import "./style.css";
// Changes tab: file tree (@pierre/trees) + stacked, virtualized diffs (@pierre/diffs CodeView).
import { CodeView, parsePatchFiles, resolveTheme, type CodeViewDiffItem, type FileDiffMetadata } from "@pierre/diffs";
import { FileTree, themeToTreeStyles, type GitStatusEntry } from "@pierre/trees";
import { connect, type HarnessPlugin } from "@harness/plugin-sdk";
import type { Ticket } from "@harness/shared";
import type { ChangedFile, Changes, Commit } from "../git";
import { readSidebarCollapsed, readStyle, saveSidebarCollapsed, saveStyle, type DiffStyle } from "./prefs";
import { PIERRE_DEFAULT, syntaxThemeName, treeStylesFor, viewerThemes } from "./theme";

interface Log {
  mode: Changes["mode"];
  base: string | null;
  commits: Commit[];
}

const NARROW = 720;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | null | false)[]) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const ICONS = {
  branch: "M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9",
  refresh: "M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15",
  chevron: "M6 9l6 6 6-6",
  sidebar: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM9 4v16",
  commit: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM1.05 12H8M16 12h6.95",
  alert: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01",
  check: "M20 6 9 17l-5-5",
};
function icon(name: keyof typeof ICONS, size = 14) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("class", "icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

function relTime(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const itemId = (path: string) => `diff:${path}`;

class ChangesView {
  private changes: Changes | null = null;
  private log: Log | null = null;
  private error: string | null = null;
  private loading = false;
  private queued = false;
  private lastPatchKey = "";
  private viewer: CodeView | null = null;
  private tree: FileTree | null = null;
  private diffStyle: DiffStyle;
  private styleChosen: boolean;
  private showCommits = false;
  /** Narrow widths: whether the file overlay is open. Wide widths: whether the docked sidebar is collapsed (persisted). */
  private showFiles = false;
  private filesCollapsed = readSidebarCollapsed();
  private wasNarrow: boolean | null = null;
  private busy = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Tree CSS variables per Shiki theme name, the theme in use, and names that failed to resolve */
  private treeThemes = new Map<string, Record<string, string>>();
  private themeName: string;
  private failedThemes = new Set<string>();
  private themeSeq = 0;
  private treeVars: string[] = [];
  private diffsById = new Map<string, FileDiffMetadata>();

  constructor(
    private root: HTMLElement,
    private host: HarnessPlugin,
  ) {
    this.themeName = PIERRE_DEFAULT[host.theme];
    const saved = readStyle();
    this.styleChosen = !!saved;
    this.diffStyle = saved ?? (innerWidth >= 1000 ? "split" : "unified");
    root.innerHTML = "";
    root.append(
      h("header", { class: "bar" }),
      h("div", { class: "commits", hidden: "" }),
      h("div", { class: "notice", hidden: "" }),
      h("main", { class: "body" }, h("aside", { class: "files" }), h("section", { class: "diffs" }), h("div", { class: "state", hidden: "" })),
    );
    host.onTheme(() => void this.applyTheme()); // light↔dark and dark→dark (another app theme)
    host.onTicket((t) => this.onTicket(t));
    new ResizeObserver(() => this.layout()).observe(root);
    document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && this.refresh());
    void this.applyTheme();
    this.renderBar();
    void this.refresh();
  }

  // --- data -------------------------------------------------------------------------------

  async refresh() {
    if (this.loading) {
      this.queued = true;
      return;
    }
    this.loading = true;
    this.renderBar();
    try {
      const key = encodeURIComponent(this.host.ticketKey);
      const [changes, log] = await Promise.all([this.host.api<Changes>(`changes?ticket=${key}`), this.host.api<Log>(`log?ticket=${key}`)]);
      this.changes = changes;
      this.log = log;
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      this.loading = false;
    }
    this.render();
    if (this.queued) {
      this.queued = false;
      void this.refresh();
    }
  }

  private onTicket(t: Ticket) {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), 600);
    // File edits don't emit ticket events; poll while the agent is working.
    if (t.busy !== this.busy) {
      this.busy = t.busy;
      if (this.poll) clearInterval(this.poll);
      this.poll = t.busy ? setInterval(() => document.visibilityState === "visible" && void this.refresh(), 4000) : null;
    }
  }

  // --- theme ------------------------------------------------------------------------------

  /** Follow the app theme: its matching Shiki theme for diffs and the tree, else Pierre's default. */
  private async applyTheme() {
    const appearance = this.host.theme;
    const want = syntaxThemeName(appearance, this.host.syntaxTheme, this.failedThemes);
    const seq = ++this.themeSeq;
    const { name } = await treeStylesFor(appearance, want, this.treeThemes, this.failedThemes, async (n) => themeToTreeStyles(await resolveTheme(n)));
    if (seq !== this.themeSeq) return; // a newer theme change won
    this.themeName = name;
    this.viewer?.setOptions(this.viewerOptions());
    this.styleTree();
  }

  private styleTree() {
    const el = this.tree?.getFileTreeContainer();
    const vars = this.treeThemes.get(this.themeName);
    if (!el || !vars) return;
    for (const k of this.treeVars) if (!(k in vars)) el.style.removeProperty(k);
    this.treeVars = Object.keys(vars).filter((k) => k.startsWith("--"));
    for (const k of this.treeVars) el.style.setProperty(k, vars[k]!);
    // Blend the tree into our sidebar surface rather than the theme's editor background.
    el.style.setProperty("--trees-bg-override", "transparent");
    el.style.setProperty("--trees-border-color-override", "transparent");
  }

  // --- layout -----------------------------------------------------------------------------

  private get narrow() {
    return this.root.clientWidth < NARROW;
  }

  private layout() {
    const narrow = this.narrow;
    this.root.classList.toggle("narrow", narrow);
    this.root.classList.toggle("files-open", narrow && this.showFiles);
    this.root.classList.toggle("files-collapsed", !narrow && this.filesCollapsed);
    if (narrow !== this.wasNarrow) {
      // The files button's label and pressed state describe a different thing on each side of the breakpoint.
      const first = this.wasNarrow === null;
      this.wasNarrow = narrow;
      if (!first) this.renderBar();
    }
    if (!this.styleChosen) {
      const want: DiffStyle = this.root.clientWidth >= 1000 ? "split" : "unified";
      if (want !== this.diffStyle) {
        this.diffStyle = want;
        this.viewer?.setOptions(this.viewerOptions());
        this.renderBar();
      }
    }
  }

  private setStyle(s: DiffStyle) {
    this.diffStyle = s;
    this.styleChosen = true;
    saveStyle(s);
    this.viewer?.setOptions(this.viewerOptions());
    this.renderBar();
  }

  // --- render -----------------------------------------------------------------------------

  private render() {
    this.renderBar();
    this.renderCommits();
    this.renderNotice();
    const state = $(".state", this.root);
    const c = this.changes;
    if (this.error && !c) return this.showState("alert", "Couldn't load changes", this.error);
    if (!c) return this.showState(null, "Loading changes…", "");
    if (!c.files.length) {
      const detail =
        c.mode === "branch"
          ? `${c.branch ?? "This branch"} matches ${c.base ?? "its base"} and the worktree is clean. Changes appear here as the agent edits files.`
          : c.mode === "pinned"
            ? `${c.branch ?? "This branch"} didn't change anything before its worktree was removed.`
            : "The working tree is clean. Changes appear here as the agent edits files.";
      this.showState("check", c.mode === "pinned" ? "No changes" : "No changes yet", detail);
      this.lastPatchKey = "";
      this.viewer?.setItems([]);
      this.tree?.resetPaths([]);
      return;
    }
    state.hidden = true;
    this.root.classList.remove("empty");
    this.renderTree(c.files);
    this.renderDiffs(c);
  }

  private showState(ic: keyof typeof ICONS | null, title: string, detail: string) {
    const state = $(".state", this.root);
    state.hidden = false;
    this.root.classList.add("empty");
    state.replaceChildren(
      h("div", { class: "state-inner" }, ic ? h("div", { class: `state-icon ${ic}` }, icon(ic, 18)) : h("div", { class: "spinner" }), h("strong", {}, title), detail ? h("p", {}, detail) : null),
    );
  }

  private renderBar() {
    const bar = $(".bar", this.root);
    const c = this.changes;
    const commits = this.log?.commits ?? [];
    const short = (sha: string | null) => sha?.slice(0, 7) ?? null;
    const title =
      c?.mode === "branch"
        ? h("span", { class: "refs" }, icon("branch"), h("code", { class: "ref", title: c.head ?? "" }, c.branch ?? "HEAD"), h("span", { class: "arrow" }, "→"), h("code", { class: "ref base", title: c.baseSha ?? "" }, c.base ?? "no base"))
        : c?.mode === "pinned"
          ? h(
              "span",
              { class: "refs" },
              icon("branch"),
              h("code", { class: "ref", title: c.head ?? "" }, c.branch ?? short(c.head) ?? "HEAD"),
              h("span", { class: "arrow" }, "→"),
              h("code", { class: "ref base", title: c.base ? `${c.base} at ${c.baseSha}` : (c.baseSha ?? "") }, short(c.baseSha) ?? "no base"),
              h(
                "span",
                {
                  class: "pinned",
                  title: `The worktree is gone, so this is the diff saved while it existed: ${short(c.baseSha)}..${short(c.worktree ?? c.head)}${c.worktree ? " (including changes that were never committed)" : ""}.`,
                },
                "Saved",
              ),
            )
          : c
          ? h("span", { class: "refs" }, icon("branch"), h("span", { class: "muted" }, "Uncommitted on"), h("code", { class: "ref" }, c.branch ?? "HEAD"))
          : h("span", { class: "refs muted" }, "Changes");

    const commitBtn =
      c?.mode === "branch" || c?.mode === "pinned"
        ? h("button", { class: `chip ${this.showCommits ? "on" : ""}`, title: "Show commits", "data-action": "commits", ...(commits.length ? {} : { disabled: "" }) }, icon("commit", 13), plural(commits.length, "commit"), commits.length ? icon("chevron", 12) : null)
        : null;
    const stat = c && c.files.length ? h("span", { class: "stat" }, h("span", { class: "add" }, `+${c.additions}`), h("span", { class: "del" }, `−${c.deletions}`), h("span", { class: "muted" }, `across ${plural(c.files.length, "file")}`)) : null;
    const filesShown = this.narrow ? this.showFiles : !this.filesCollapsed;
    const filesBtn = h(
      "button",
      { class: `btn icon-only files-toggle ${this.narrow && this.showFiles ? "on" : ""}`, title: filesShown ? "Hide files" : "Show files", "aria-label": "Files", "aria-expanded": String(filesShown), "data-action": "files" },
      icon("sidebar"),
    );
    const seg = h(
      "div",
      { class: "seg", role: "group" },
      h("button", { class: this.diffStyle === "unified" ? "on" : "", "data-action": "unified" }, "Unified"),
      h("button", { class: this.diffStyle === "split" ? "on" : "", "data-action": "split" }, "Split"),
    );
    const refresh = h("button", { class: `btn icon-only ${this.loading ? "spinning" : ""}`, title: "Refresh", "data-action": "refresh" }, icon("refresh"));
    bar.replaceChildren(filesBtn, title, commitBtn ?? "", stat ?? "", h("div", { class: "grow" }), seg, refresh);
    bar.onclick = (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
      if (a === "refresh") void this.refresh();
      else if (a === "unified" || a === "split") this.setStyle(a);
      else if (a === "commits") {
        this.showCommits = !this.showCommits;
        this.renderBar();
        this.renderCommits();
      } else if (a === "files") {
        if (this.narrow) this.showFiles = !this.showFiles;
        else saveSidebarCollapsed((this.filesCollapsed = !this.filesCollapsed));
        this.layout();
        this.renderBar();
      }
    };
  }

  private renderCommits() {
    const box = $(".commits", this.root);
    const commits = this.log?.commits ?? [];
    box.hidden = !this.showCommits || !commits.length;
    if (box.hidden) return;
    box.replaceChildren(
      h(
        "ol",
        {},
        ...commits.map((c) => h("li", {}, h("code", { class: "sha", title: c.sha }, c.shortSha), h("span", { class: "subject" }, c.subject), h("span", { class: "muted", title: new Date(c.date).toLocaleString() }, `${c.author} · ${relTime(c.date)}`))),
      ),
    );
  }

  private renderNotice() {
    const n = $(".notice", this.root);
    const c = this.changes;
    const msgs: string[] = [];
    if (c?.truncated) msgs.push(`This diff is large, so only the first part is shown. ${plural(c.files.length, "file")} changed in total.`);
    if (this.error && c) msgs.push(`Refresh failed: ${this.error}`);
    n.hidden = !msgs.length;
    n.replaceChildren(...msgs.map((m) => h("div", {}, icon("alert", 13), m)));
  }

  private renderTree(files: ChangedFile[]) {
    const paths = files.map((f) => f.path);
    const stats = new Map(files.map((f) => [f.path, f]));
    const git: GitStatusEntry[] = files.map((f) => ({ path: f.path, status: f.status }));
    if (!this.tree) {
      this.tree = new FileTree({
        paths,
        gitStatus: git,
        initialExpansion: "open",
        flattenEmptyDirectories: true,
        density: "compact",
        search: false,
        renderRowDecoration: ({ item }) => {
          const f = stats.get(item.path);
          if (!f || item.kind !== "file") return null;
          if (f.binary) return { text: "bin", title: "Binary file" };
          if (f.status === "renamed" && !f.additions && !f.deletions) return f.oldPath ? { text: "moved", title: `Renamed from ${f.oldPath}` } : null;
          return {
            text: `+${f.additions} −${f.deletions}`,
            title: `${f.additions} additions, ${f.deletions} deletions`,
            parts: [
              { text: `+${f.additions}`, color: "var(--add)" },
              { text: " " },
              { text: `−${f.deletions}`, color: "var(--del)" },
            ],
          };
        },
        onSelectionChange: (selected) => {
          const path = selected[0];
          if (!path || !this.diffsById.has(itemId(path))) return;
          this.viewer?.scrollTo({ type: "item", id: itemId(path), align: "start", behavior: "smooth" });
          if (this.narrow) {
            this.showFiles = false;
            this.layout();
            this.renderBar();
          }
        },
      });
      this.tree.render({ containerWrapper: $(".files", this.root) });
      this.styleTree();
      // Decorations close over `stats`; keep a live reference for later refreshes.
      this.treeStats = stats;
    } else {
      this.treeStats.clear();
      for (const [k, v] of stats) this.treeStats.set(k, v);
      const current = new Set(this.lastPaths);
      if (paths.length !== current.size || paths.some((p) => !current.has(p))) this.tree.resetPaths(paths);
      this.tree.setGitStatus(git);
    }
    this.lastPaths = paths;
  }
  private treeStats = new Map<string, ChangedFile>();
  private lastPaths: string[] = [];

  private viewerOptions() {
    return {
      theme: viewerThemes(this.host.theme, this.themeName),
      themeType: this.host.theme,
      diffStyle: this.diffStyle,
      stickyHeaders: true,
      hunkSeparators: "line-info-basic",
      lineDiffType: "word-alt",
      overflow: "scroll",
      layout: { paddingTop: 12, paddingBottom: 24, gap: 12 },
      loadDiffFiles: (d: FileDiffMetadata) => this.loadFiles(d),
    } as const;
  }

  private async loadFiles(d: FileDiffMetadata) {
    const c = this.changes!;
    const key = encodeURIComponent(this.host.ticketKey);
    const get = async (side: "old" | "new", path: string) => {
      const q = `file?ticket=${key}&side=${side}&path=${encodeURIComponent(path)}${side === "old" && c.baseSha ? `&ref=${c.baseSha}` : ""}`;
      return (await this.host.api<{ contents: string | null }>(q)).contents ?? "";
    };
    const newFile = { name: d.name, contents: await get("new", d.name), cacheKey: `new:${d.name}:${this.lastPatchKey}` };
    if (d.type === "rename-pure") return { oldFile: null, newFile };
    const oldName = d.prevName ?? d.name;
    return { oldFile: { name: oldName, contents: await get("old", oldName), cacheKey: `old:${c.baseSha}:${oldName}` }, newFile };
  }

  private renderDiffs(c: Changes) {
    const patchKey = `${c.baseSha}:${c.patch.length}:${hash(c.patch)}`;
    if (patchKey === this.lastPatchKey && this.viewer) return;
    this.lastPatchKey = patchKey;
    const parsed = parsePatchFiles(c.patch, `p${patchKey}`).flatMap((p) => p.files);
    this.diffsById.clear();
    const items: CodeViewDiffItem[] = parsed.map((fileDiff) => {
      const id = itemId(fileDiff.name);
      this.diffsById.set(id, fileDiff);
      return { id, type: "diff", fileDiff };
    });
    if (!this.viewer) {
      this.viewer = new CodeView(this.viewerOptions());
      this.viewer.setup($(".diffs", this.root));
    }
    this.viewer.setItems(items);
  }
}

function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return (x >>> 0).toString(36);
}

async function main() {
  const root = document.getElementById("app")!;
  try {
    const host = await connect();
    (window as unknown as { __gitPlugin: ChangesView }).__gitPlugin = new ChangesView(root, host);
  } catch (e) {
    root.innerHTML = "";
    root.append(h("div", { class: "state" }, h("div", { class: "state-inner" }, h("strong", {}, "Open this tab from Harness"), h("p", {}, (e as Error).message))));
  }
}

void main();
