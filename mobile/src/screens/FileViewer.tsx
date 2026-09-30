// The file a chat link points at (app/file.tsx, opened from a harness://file/… link in any
// markdown): the whole file syntax highlighted with line numbers, opened at and tinting the linked
// lines, plus a Diff tab with its uncommitted changes when git says it has some. Lines are a
// virtualized list with fixed row heights, so a file of thousands of lines opens straight at its
// range; a long file is colored a window at a time around what's on screen (fileViewer.highlightWindow).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type ViewToken } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { formatFileLink, HarnessApiError, type FileDiff, type FileView } from "@harness/shared";
import { langForPath } from "@harness/shared/diff";
import { useColors, useTheme } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { fileLines, formatSize, highlightWindow, initialScrollIndex, patchRows, readFileParams, type FileRoot, type PatchRow } from "../lib/fileViewer";
import { diffTints, gitColors, hasLanguage, type Span } from "../lib/highlight";
import { spanStyle, useHighlight, useSyntaxTheme } from "../ui/CodeBlock";
import { Badge, Button, Empty, Spinner } from "../ui/kit";
import { action, menuItem } from "../ui/header";
import { haptic } from "../ui/haptics";

const FONT = 12.5;
const ROW = 19;
const PAD = 10;
/** Menlo's advance width is 0.602 em. */
const CHAR = FONT * 0.602;
/** Lines are laid out this many characters wide at most; longer ones are clipped. */
const MAX_COLS = 400;
/** Characters of a long file tokenized at once (the highlighter's cap is 60 000). */
const WINDOW_CHARS = 40_000;

type Load<T> = { state: "loading" } | { state: "ok"; value: T } | { state: "error"; status: number | null; message: string };

const failed = (e: unknown): Load<never> => ({ state: "error", status: e instanceof HarnessApiError ? e.status : null, message: e instanceof Error ? e.message : String(e) });
const tabs = (s: string) => s.replace(/\t/g, "    ");
/** Not Math.max(...n): a file's worth of lines overflows the call's argument limit. */
const longest = (n: number[]) => n.reduce((a, b) => (b > a ? b : a), 0);
const fileName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

export function FileViewerScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const target = useMemo(() => readFileParams(params), [params.path, params.ticket, params.project, params.start, params.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const c = useColors();
  if (!target || !target.root)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Stack.Screen options={{ title: target ? fileName(target.path) : "File" }} />
        <Empty icon="fileText" title="Can't open this file">
          {target ? "The link doesn't say which ticket or project the file is in." : "The link doesn't name a file."}
        </Empty>
      </View>
    );
  return <Viewer root={target.root} path={target.path} range={target.range} />;
}

function Viewer({ root, path, range }: { root: FileRoot; path: string; range: [number, number] | null }) {
  const { client, state, toast } = useStore();
  const c = useColors();
  const router = useRouter();
  const [file, setFile] = useState<Load<FileView>>({ state: "loading" });
  const [diff, setDiff] = useState<Load<FileDiff> | null>(null);
  const [tab, setTab] = useState<"file" | "diff">("file");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const view: Load<FileView> = await (root.kind === "ticket" ? client.ticketFile(root.key, path) : client.projectFile(root.id, path)).then((value) => ({ state: "ok", value }) as const, failed);
    setFile(view);
    // Only a file git says changed has a diff (and outside a repository the endpoint is a 409).
    if (view.state !== "ok" || !view.value.git.repo || !view.value.git.dirty) return setDiff(null);
    setDiff((d) => d ?? { state: "loading" });
    const p = view.value.path;
    setDiff(await (root.kind === "ticket" ? client.ticketFileDiff(root.key, p) : client.projectFileDiff(root.id, p)).then((value) => ({ state: "ok", value }) as const, failed));
  }, [client, root.kind, root.kind === "ticket" ? root.key : root.id, path]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const view = file.state === "ok" ? file.value : null;
  const shownPath = view?.path ?? path;
  const rows = useMemo(() => (diff?.state === "ok" ? patchRows(diff.value.patch) : []), [diff]);
  const hasDiff = !!view?.git.repo && view.git.dirty;
  const shown = hasDiff ? tab : "file";
  const where = root.kind === "ticket" ? root.key : (state.projects[root.id]?.name ?? "Project");
  const link = formatFileLink({
    path: shownPath,
    ...(root.kind === "ticket" ? { ticketKey: root.key } : { projectId: root.id }),
    startLine: range?.[0],
    endLine: range && range[1] !== range[0] ? range[1] : undefined,
  });

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 240 }}>
              <Text style={{ color: c.text, fontSize: 16, fontWeight: "600" }} numberOfLines={1} ellipsizeMode="middle">
                {fileName(shownPath)}
              </Text>
              <Text style={{ color: c.text3, fontSize: 12, fontFamily: root.kind === "ticket" ? MONO : undefined }} numberOfLines={1}>
                {where}
              </Text>
            </View>
          ),
          unstable_headerRightItems: () => [
            menuItem("More", "ellipsis.circle", [
              action("Copy path", "doc.on.doc", () => void Clipboard.setStringAsync(shownPath).then(() => toast("Path copied", "info"))),
              action("Copy link", "link", () => void Clipboard.setStringAsync(link).then(() => toast("Link copied", "info"))),
              ...(root.kind === "ticket" ? [action(`Open ${root.key}`, "arrow.right.circle", () => router.push({ pathname: "/ticket/[key]", params: { key: root.key } }))] : []),
            ]),
          ],
        }}
      />
      <InfoBar path={shownPath} view={view} range={range} />
      {hasDiff && <Tabs tab={shown} onTab={setTab} rows={rows} />}
      <View style={{ flex: 1 }}>
        {file.state === "loading" && <Centered />}
        {file.state === "error" && <LoadError what="file" error={file} path={path} onRetry={() => void refresh()} />}
        {view && shown === "file" && <FileBody key={`${view.path}:${view.size}`} view={view} range={range} refreshing={refreshing} onRefresh={refresh} />}
        {view && shown === "diff" && <DiffBody path={view.path} diff={diff} rows={rows} refreshing={refreshing} onRefresh={refresh} />}
      </View>
    </View>
  );
}

function InfoBar({ path, view, range }: { path: string; view: FileView | null; range: [number, number] | null }) {
  const c = useColors();
  const git = view?.git;
  const lines = view?.contents != null ? fileLines(view.contents).length : null;
  const meta = [
    view ? formatSize(view.size) : null,
    lines !== null ? `${lines} line${lines === 1 ? "" : "s"}` : null,
    range ? (range[0] === range[1] ? `line ${range[0]}` : `lines ${range[0]}–${range[1]}`) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.info, { borderBottomColor: c.border }]}>
      <Text style={{ color: c.text2, fontFamily: MONO, fontSize: 12 }} numberOfLines={1} ellipsizeMode="head" selectable>
        {path}
      </Text>
      {!!view && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {git?.untracked ? <Badge tone="green">Untracked</Badge> : git?.dirty ? <Badge tone="amber">Modified</Badge> : null}
          {git?.ignored && <Badge>Ignored</Badge>}
          <Text style={{ color: c.text3, fontSize: 12.5 }}>{meta}</Text>
        </View>
      )}
    </View>
  );
}

function Tabs({ tab, onTab, rows }: { tab: "file" | "diff"; onTab: (t: "file" | "diff") => void; rows: PatchRow[] }) {
  const c = useColors();
  const added = rows.filter((r) => r.kind === "add").length;
  const removed = rows.filter((r) => r.kind === "del").length;
  const item = (id: "file" | "diff", label: string, extra?: ReactElement) => {
    const on = tab === id;
    return (
      <Pressable
        key={id}
        accessibilityRole="tab"
        accessibilityState={{ selected: on }}
        onPress={() => {
          if (!on) haptic("select");
          onTab(id);
        }}
        style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: on ? c.accent : "transparent" }}
      >
        <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? "600" : "500", fontSize: 14.5 }}>{label}</Text>
        {extra}
      </Pressable>
    );
  };
  return (
    <View style={{ flexDirection: "row", paddingHorizontal: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }} accessibilityRole="tablist">
      {item("file", "File")}
      {item(
        "diff",
        "Diff",
        added || removed ? (
          <Text style={{ fontFamily: MONO, fontSize: 12 }}>
            {added ? <Text style={{ color: c.diffAdd }}>+{added}</Text> : null}
            {added && removed ? " " : null}
            {removed ? <Text style={{ color: c.diffDel }}>−{removed}</Text> : null}
          </Text>
        ) : undefined,
      )}
    </View>
  );
}

function Centered() {
  return (
    <View style={{ flex: 1, justifyContent: "center" }}>
      <Spinner />
    </View>
  );
}

function LoadError({ what, error, path, onRetry }: { what: "file" | "diff"; error: Extract<Load<unknown>, { state: "error" }>; path: string; onRetry: () => void }) {
  if (what === "file" && error.status === 404)
    return (
      <Empty icon="fileText" title="File not found">
        {`${path} isn't there. It may have been moved or deleted, or the link's path is off.`}
      </Empty>
    );
  if (what === "file" && error.status === 400)
    return (
      <Empty icon="alert" title="Can't open this path">
        {error.message}
      </Empty>
    );
  return (
    <Empty icon="alert" title={what === "file" ? "Couldn't load the file" : "Couldn't load the diff"} action={<Button title="Try again" icon="refresh" small onPress={onRetry} />}>
      {error.message}
    </Empty>
  );
}

/**
 * A horizontally scrolling, vertically virtualized list of fixed-height code rows: every row is
 * laid out `width` wide, so long lines scroll sideways together instead of wrapping (which would
 * break the fixed heights that let the list open straight at a line).
 */
function CodeList<T>({
  rows,
  width,
  renderRow,
  initialIndex,
  refreshing,
  onRefresh,
  onVisible,
}: {
  rows: T[];
  width: number;
  renderRow: (row: T, index: number) => ReactElement;
  initialIndex?: number;
  refreshing: boolean;
  onRefresh: () => void;
  onVisible?: (first: number, last: number) => void;
}) {
  const { width: screen } = useWindowDimensions();
  const visible = useRef(onVisible);
  visible.current = onVisible;
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const idx = viewableItems.map((v) => v.index).filter((i): i is number => i !== null);
    if (idx.length) visible.current?.(Math.min(...idx), Math.max(...idx));
  }).current;
  return (
    <ScrollView horizontal style={{ flex: 1 }} contentContainerStyle={{ minWidth: "100%" }} bounces={false} directionalLockEnabled>
      <FlatList
        style={{ width: Math.max(width, screen) }}
        data={rows}
        keyExtractor={(_, i) => String(i)}
        renderItem={({ item, index }) => renderRow(item, index)}
        getItemLayout={(_, index) => ({ length: ROW, offset: PAD + ROW * index, index })}
        initialScrollIndex={initialIndex && initialIndex < rows.length ? initialIndex : undefined}
        initialNumToRender={60}
        maxToRenderPerBatch={80}
        windowSize={15}
        contentContainerStyle={{ paddingVertical: PAD }}
        onViewableItemsChanged={onViewableItemsChanged}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        showsVerticalScrollIndicator={width <= screen}
      />
    </ScrollView>
  );
}

function Spans({ spans, fg }: { spans: Span[]; fg: string }) {
  return (
    <>
      {spans.map((s, j) => (
        <Text key={j} style={spanStyle(s, fg)}>
          {tabs(s.text)}
        </Text>
      ))}
    </>
  );
}

function FileBody({ view, range, refreshing, onRefresh }: { view: FileView; range: [number, number] | null; refreshing: boolean; onRefresh: () => void }) {
  const { c, resolved } = useTheme();
  const syntaxTheme = useSyntaxTheme();
  const lines = useMemo(() => (view.contents === null ? [] : fileLines(view.contents)), [view.contents]);
  const lengths = useMemo(() => lines.map((l) => tabs(l).length), [lines]);
  const lang = langForPath(view.path);
  const [center, setCenter] = useState(range ? range[0] - 1 : 0);
  const win = useMemo(() => highlightWindow(lengths, center, WINDOW_CHARS), [lengths, center]);
  const code = useMemo(() => lines.slice(win[0], win[1]).join("\n"), [lines, win]);
  const hl = useHighlight(code, lang && hasLanguage(lang) ? lang : null, syntaxTheme, false, resolved);
  // Colored lines pile up as windows are highlighted, so scrolling back never goes plain again.
  const colored = useMemo(() => new Map<number, Span[]>(), [lines, syntaxTheme]); // eslint-disable-line react-hooks/exhaustive-deps
  if (hl) hl.lines.forEach((l, i) => colored.set(win[0] + i, l.spans));
  const fg = hl?.fg ?? c.text;
  const winRef = useRef(win);
  winRef.current = win;

  if (view.tooLarge) return <Empty icon="fileText" title="Too large to show">{`This file is ${formatSize(view.size)}; the viewer opens files up to 2 MB.`}</Empty>;
  if (view.binary || view.contents === null) return <Empty icon="image" title="Binary file">{`${formatSize(view.size)} of binary data.`}</Empty>;
  if (view.contents === "") return <Empty icon="fileText" title="Empty file" />;

  const gutter = Math.ceil(String(lines.length).length * CHAR) + 20;
  const width = gutter + PAD * 2 + Math.min(MAX_COLS, longest(lengths)) * CHAR;
  const inRange = (i: number) => !!range && i + 1 >= range[0] && i + 1 <= range[1];
  return (
    <View style={{ flex: 1 }}>
      {view.truncated && <Text style={[styles.note, { color: c.text3, borderBottomColor: c.border }]}>The file changed while it was read; this is only its start.</Text>}
      <CodeList
        rows={lines}
        width={width}
        initialIndex={initialScrollIndex(range?.[0], lines.length)}
        refreshing={refreshing}
        onRefresh={onRefresh}
        onVisible={(first, last) => {
          const [from, to] = winRef.current;
          if (first < from || last >= to) setCenter(Math.round((first + last) / 2));
        }}
        renderRow={(line, i) => {
          const on = inRange(i);
          return (
            <View style={[styles.row, on && { backgroundColor: c.accentSoft }]}>
              <View style={[styles.gutterEdge, { backgroundColor: on ? c.accent : "transparent" }]} />
              <Text style={[styles.code, { width: gutter - 3, paddingRight: 12, textAlign: "right", color: on ? c.accentText : c.text3, fontWeight: on ? "600" : undefined }]}>{i + 1}</Text>
              <Text style={[styles.code, { flex: 1, paddingRight: PAD, color: fg }]} numberOfLines={1} ellipsizeMode="clip">
                {colored.has(i) ? <Spans spans={colored.get(i)!} fg={fg} /> : tabs(line)}
              </Text>
            </View>
          );
        }}
      />
    </View>
  );
}

function DiffBody({ path, diff, rows, refreshing, onRefresh }: { path: string; diff: Load<FileDiff> | null; rows: PatchRow[]; refreshing: boolean; onRefresh: () => void }) {
  const { c, resolved } = useTheme();
  const syntaxTheme = useSyntaxTheme();
  const patch = diff?.state === "ok" ? diff.value.patch : "";
  // The patch highlighted as a diff: its lines line up with parseDiff's, which PatchRow.source indexes.
  const hl = useHighlight(patch, null, syntaxTheme, true, resolved);
  const git = hl ?? gitColors(undefined, resolved);
  const tints = diffTints(c.bg, git, resolved);
  const fg = hl?.fg ?? c.text;

  if (!diff || diff.state === "loading") return <Centered />;
  if (diff.state === "error") return <LoadError what="diff" error={diff} path={path} onRetry={onRefresh} />;
  if (diff.value.tooLarge)
    return (
      <Empty icon="branch" title="Too many changes to show">
        The diff is over 4 MB.
      </Empty>
    );
  if (!patch)
    return (
      <Empty icon="checkCircle" title="No uncommitted changes">
        The file matches the last commit.
      </Empty>
    );
  if (!rows.length)
    return (
      <Empty icon="image" title="Binary file changed">
        Git can't show a line-by-line diff for it.
      </Empty>
    );

  const most = rows.reduce((n, r) => Math.max(n, r.oldLine ?? 0, r.newLine ?? 0), 0);
  const num = Math.ceil(String(most).length * CHAR) + 10;
  const width = num * 2 + CHAR * 2 + PAD * 2 + Math.min(MAX_COLS, longest(rows.map((r) => tabs(r.text).length))) * CHAR;
  return (
    <CodeList
      rows={rows}
      width={width}
      refreshing={refreshing}
      onRefresh={onRefresh}
      renderRow={(r) => {
        if (r.kind === "hunk")
          return (
            <View style={[styles.row, { backgroundColor: c.bgSunken }]}>
              <Text style={[styles.code, { paddingLeft: PAD, color: c.text3 }]} numberOfLines={1} ellipsizeMode="clip">
                {r.text}
              </Text>
            </View>
          );
        const spans = hl?.lines[r.source]?.spans.slice(1) ?? [{ text: r.text }];
        const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : " ";
        const signColor = r.kind === "add" ? git.added : r.kind === "del" ? git.deleted : c.text3;
        return (
          <View style={[styles.row, { backgroundColor: r.kind === "add" ? tints.add : r.kind === "del" ? tints.del : undefined }]}>
            <Text style={[styles.code, { width: num, textAlign: "right", color: c.text3 }]}>{r.oldLine ?? ""}</Text>
            <Text style={[styles.code, { width: num, textAlign: "right", color: c.text3 }]}>{r.newLine ?? ""}</Text>
            <Text style={[styles.code, { width: CHAR * 2 + 8, textAlign: "center", color: signColor }]}>{sign}</Text>
            <Text style={[styles.code, { flex: 1, paddingRight: PAD, color: fg }]} numberOfLines={1} ellipsizeMode="clip">
              <Spans spans={spans} fg={fg} />
            </Text>
          </View>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  info: { paddingHorizontal: 14, paddingVertical: 9, gap: 6, borderBottomWidth: StyleSheet.hairlineWidth },
  note: { paddingHorizontal: 14, paddingVertical: 8, fontSize: 12.5, borderBottomWidth: StyleSheet.hairlineWidth },
  row: { height: ROW, flexDirection: "row", alignItems: "center" },
  gutterEdge: { width: 3, alignSelf: "stretch" },
  code: { fontFamily: MONO, fontSize: FONT, lineHeight: ROW },
});
