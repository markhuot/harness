// The board: five columns as horizontally paged lists with a status bar (counts) on top, the
// project filter in the header (sidebar equivalent in /projects), server-side search in the native
// search bar, "Show child tickets" in the header menu (off by default), pull to refresh.
// Done is paged: it scrolls into older pages (onEndReached, footer spinner) and its count is the
// server's total. Search results page the same way, across every column.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Stack, useRouter } from "expo-router";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { boardColumns, COLUMN_EMPTY_TEXT, doneCount, hideOnBoard, positionForDrop, scopeOf, searchColumns, searchStatusText, STATUS_LABEL } from "@harness/shared/state";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { StatusDot, Empty, Spinner } from "../ui/kit";
import { shouldAutoFill } from "../lib/boardLoader";
import { TicketCard } from "./TicketCard";
import { ConnectionBanner } from "./ConnectionBanner";
import { haptic } from "../ui/haptics";
import { action, buttonItem, primaryItemStyle, menuItem } from "../ui/header";

export function BoardScreen() {
  const { state, client, dispatch, refresh, loader, setBoardScope } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pager = useRef<FlatList<TicketStatus>>(null);
  const strip = useRef<ScrollView>(null);
  const chipX = useRef<Record<number, number>>({});
  useEffect(() => {
    const x = chipX.current[page];
    if (x !== undefined) strip.current?.scrollTo({ x: Math.max(0, x - 40), animated: true });
  }, [page]);

  const projectId = prefs.boardProject && state.projects[prefs.boardProject] ? prefs.boardProject : null;
  const project = projectId ? state.projects[projectId] : null;
  const hideChildren = prefs.hideChildren;
  const scope = scopeOf(projectId);

  // Paging follows the project filter; a refetch drops the paging, so ask again when it's gone.
  useEffect(() => setBoardScope(projectId), [projectId, setBoardScope]);
  useEffect(() => void loader.ensureFirstPage(projectId), [loader, projectId, state.ready, state.donePaging]);
  // Every keystroke: local matches at once, the server's after a pause (see BoardLoader).
  useEffect(() => loader.setQuery(query, projectId), [loader, query, projectId]);

  const search = state.search;
  const searching = search !== null;
  const board = useMemo(() => boardColumns(state, projectId), [state.tickets, state.donePaging, state.keyAliases, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => searchColumns(state, projectId), [state.tickets, state.search, state.keyAliases, projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Search shows every match (children included): hiding one would read as "not found".
  const shown = useMemo(
    () => (searching ? results.columns : (Object.fromEntries(TICKET_STATUSES.map((s) => [s, board[s].filter((t) => !hideOnBoard(t, hideChildren))])) as Record<TicketStatus, Ticket[]>)),
    [searching, results, board, hideChildren],
  );
  const count = (s: TicketStatus) => (!searching && s === "done" ? doneCount(state, projectId, shown.done.length) : shown[s].length);
  const total = TICKET_STATUSES.reduce((n, s) => n + (s === "done" ? doneCount(state, projectId, board.done.length) : board[s].length), 0);
  const paging = state.donePaging[scope];

  // Hidden children can leave the loaded Done run nearly empty: while Done is on screen, top it up.
  const onDone = TICKET_STATUSES[page] === "done";
  useEffect(() => {
    if (!searching && onDone && shouldAutoFill(shown.done.length, loader.canLoadMoreDone(projectId))) void loader.loadMoreDone(projectId);
  }, [searching, onDone, shown.done.length, paging, loader, projectId]);

  const onEnd = useCallback(
    (status: TicketStatus) => {
      if (searching) void loader.loadMoreSearch();
      else if (status === "done") void loader.loadMoreDone(projectId);
    },
    [searching, loader, projectId],
  );

  // The first visit lands on the most useful column: what needs you, else what's moving.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !state.ready) return;
    landed.current = true;
    const first = (["blocked", "review", "in_progress", "planning"] as TicketStatus[]).find((s) => shown[s].length > 0);
    if (first) {
      const i = TICKET_STATUSES.indexOf(first);
      setPage(i);
      requestAnimationFrame(() => pager.current?.scrollToIndex({ index: i, animated: false }));
    }
  }, [state.ready, shown]);

  const goTo = (i: number) => {
    setPage(i);
    pager.current?.scrollToIndex({ index: i, animated: true });
  };

  // When search results land and the column on screen has none, show the first one that does.
  const resultIds = search?.ids;
  useEffect(() => {
    if (!resultIds || shown[TICKET_STATUSES[page]!].length > 0) return;
    const i = TICKET_STATUSES.findIndex((s) => shown[s].length > 0);
    if (i >= 0) goTo(i);
  }, [resultIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = useCallback(
    async (t: Ticket, status: TicketStatus, where: "top" | "bottom" = "bottom") => {
      const cols = boardColumns(state, projectId);
      const others = cols[status].filter((x) => x.id !== t.id);
      const position = status === "done" ? undefined : positionForDrop(others, where === "top" ? 0 : others.length);
      const body = { ...(t.status !== status ? { status } : {}), ...(position !== undefined ? { position } : {}) };
      if (!Object.keys(body).length) return;
      // Optimistic: a card dropped into Done is the newest completion (the service's event confirms it).
      const completedAt = t.status === status ? t.completedAt : status === "done" ? Date.now() : null;
      dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: { ...t, ...body, completedAt, updatedAt: t.updatedAt } } });
      const res = await act(() => client.updateTicket(t.key, body), t.status !== status ? `${t.key} → ${STATUS_LABEL[status]}` : undefined);
      if (!res) void refresh();
    },
    [state, projectId, dispatch, act, client, refresh],
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  };

  const onScrollEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const i = Math.round(e.nativeEvent.contentOffset.x / width);
    if (i !== page) {
      haptic("select");
      setPage(i);
    }
  };

  const openKey = useCallback((key: string) => router.push({ pathname: "/ticket/[key]", params: { key } }), [router]);

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: project ? project.name : "All projects",
          headerTransparent: false,
          headerStyle: { backgroundColor: c.bg },
          headerShadowVisible: false,
          headerSearchBarOptions: {
            placeholder: "Search tickets",
            onChangeText: (e) => setQuery(e.nativeEvent.text),
            onCancelButtonPress: () => setQuery(""),
            hideWhenScrolling: false,
            autoCapitalize: "none",
          },
          unstable_headerLeftItems: () => [buttonItem("Projects", "sidebar.left", () => router.push("/projects"))],
          unstable_headerRightItems: () => [
            menuItem("Board options", "ellipsis", [
              action("Show child tickets", "arrow.turn.down.right", () => setPref("hideChildren", !hideChildren), { state: hideChildren ? "off" : "on" }),
              ...(project ? [action("Project settings", "gearshape", () => router.push({ pathname: "/project/[id]", params: { id: project.id } }))] : []),
              action("Refresh", "arrow.clockwise", () => void onRefresh()),
            ]),
            buttonItem("New session", "plus", () => router.push({ pathname: "/new", params: projectId ? { projectId } : {} }), primaryItemStyle(c)),
          ],
        }}
      />
      <ConnectionBanner />
      <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.statusBar}>
        {TICKET_STATUSES.map((s, i) => {
          const on = i === page;
          return (
            <Pressable
              key={s}
              onPress={() => goTo(i)}
              onLayout={(e) => (chipX.current[i] = e.nativeEvent.layout.x)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${STATUS_LABEL[s]}, ${count(s)}`}
              style={[styles.statusTab, { backgroundColor: on ? c.bgElev : "transparent", borderColor: on ? c.border : "transparent" }]}
            >
              <StatusDot status={s} />
              <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? "600" : "500", fontSize: 14 }}>{STATUS_LABEL[s]}</Text>
              <Text style={{ color: c.text3, fontSize: 13, fontVariant: ["tabular-nums"] }}>{count(s)}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {search && (
        <View style={styles.searchNote} accessibilityLiveRegion="polite">
          {(search.ids === null || search.loading) && !search.error && <Spinner />}
          <Text style={{ color: search.error ? c.red : c.text3, fontSize: 13 }} numberOfLines={1}>
            {searchStatusText(search)}
          </Text>
          {search.error && (
            <Text style={{ color: c.accentText, fontSize: 13, fontWeight: "600" }} onPress={() => void loader.retrySearch()} accessibilityRole="button">
              Retry
            </Text>
          )}
        </View>
      )}
      <FlatList
        ref={pager}
        data={TICKET_STATUSES as unknown as TicketStatus[]}
        keyExtractor={(s) => s}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={onScrollEnd}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        initialNumToRender={5}
        renderItem={({ item: status }) => (
          <View style={{ width }}>
            <FlatList
              data={shown[status]}
              keyExtractor={(t) => t.id}
              onEndReached={searching || status === "done" ? () => onEnd(status) : undefined}
              onEndReachedThreshold={0.6}
              ListFooterComponent={<ColumnFooter status={status} searching={searching} />}
              contentContainerStyle={{ padding: 14, paddingBottom: 110, gap: 10 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text3} />}
              renderItem={({ item }) => <TicketCard ticket={item} state={state} showProject={!projectId} onMove={move} onOpenKey={openKey} />}
              ListEmptyComponent={
                <View style={[styles.emptyCol, { borderColor: c.borderStrong }]}>
                  {total === 0 && status === "planning" && !searching ? (
                    <Empty icon="plus" title="No sessions yet">
                      Start one with + in the top right.
                    </Empty>
                  ) : searching && results.pending ? (
                    <Text style={{ color: c.text3, fontSize: 14, textAlign: "center" }}>Searching…</Text>
                  ) : !searching && status === "done" && !loader.legacy && (!paging || paging.loading || loader.canLoadMoreDone(projectId)) && !paging?.error ? (
                    <Spinner />
                  ) : (
                    <Text style={{ color: c.text3, fontSize: 14, textAlign: "center" }}>{searching ? "No matches" : COLUMN_EMPTY_TEXT[status]}</Text>
                  )}
                </View>
              }
            />
          </View>
        )}
      />
    </View>
  );
}

/** Under a column's cards: the next page loading, or a failed page with Retry. */
function ColumnFooter({ status, searching }: { status: TicketStatus; searching: boolean }) {
  const { state, loader } = useStore();
  const c = useColors();
  const { prefs } = useApp();
  const projectId = prefs.boardProject && state.projects[prefs.boardProject] ? prefs.boardProject : null;
  if (searching) {
    // Search pages are shared by every column; the status line above carries errors.
    return state.search?.loading && state.search.ids !== null ? <View style={styles.footer}><Spinner /></View> : null;
  }
  if (status !== "done") return null;
  const p = state.donePaging[scopeOf(projectId)];
  if (p?.error)
    return (
      <Pressable onPress={() => void loader.retryDone(projectId)} accessibilityRole="button" style={styles.footer}>
        <Text style={{ color: c.text3, fontSize: 13, textAlign: "center" }}>Couldn't load older tickets. <Text style={{ color: c.accentText, fontWeight: "600" }}>Retry</Text></Text>
      </Pressable>
    );
  return p?.loading && p.nextCursor !== null ? <View style={styles.footer} accessibilityLabel="Loading older tickets"><Spinner /></View> : null;
}

const styles = StyleSheet.create({
  statusBar: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  statusTab: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth },
  emptyCol: { borderWidth: 1, borderStyle: "dashed", borderRadius: 12, paddingVertical: 24, paddingHorizontal: 12, alignItems: "center" },
  searchNote: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginHorizontal: 14, marginBottom: 2, minHeight: 22 },
  footer: { paddingVertical: 16, alignItems: "center" },
});
