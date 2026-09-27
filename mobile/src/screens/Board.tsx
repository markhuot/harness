// The board: five columns as horizontally paged lists with a status bar (counts) on top, the
// project filter in the header (sidebar equivalent in /projects), the desktop's filter as a native
// search bar, "Hide child tickets" in the header menu, pull to refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import { Stack, useRouter } from "expo-router";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { boardColumns, COLUMN_EMPTY_TEXT, hideOnBoard, isChild, positionForDrop, STATUS_LABEL } from "@harness/shared/state";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { StatusDot, Empty } from "../ui/kit";
import { TicketCard } from "./TicketCard";
import { ConnectionBanner } from "./ConnectionBanner";
import { haptic } from "../ui/haptics";
import { action, buttonItem, menuItem } from "../ui/header";

export function BoardScreen() {
  const { state, client, dispatch, refresh } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const pager = useRef<FlatList<TicketStatus>>(null);

  const projectId = prefs.boardProject && state.projects[prefs.boardProject] ? prefs.boardProject : null;
  const project = projectId ? state.projects[projectId] : null;
  const hideChildren = prefs.hideChildren;
  const columns = useMemo(() => boardColumns(state, projectId), [state, projectId]);
  const q = filter.trim().toLowerCase();
  const visible = useCallback((t: Ticket) => !hideOnBoard(t, hideChildren) && (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)), [hideChildren, q]);
  const shown = useMemo(() => Object.fromEntries(TICKET_STATUSES.map((s) => [s, columns[s].filter(visible)])) as Record<TicketStatus, Ticket[]>, [columns, visible]);
  const hasChildren = Object.values(columns).some((col) => col.some(isChild));
  const hiddenCount = hideChildren ? Object.values(columns).reduce((n, col) => n + col.filter((t) => hideOnBoard(t, true)).length, 0) : 0;
  const total = Object.values(columns).reduce((n, col) => n + col.length, 0);

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

  const move = useCallback(
    async (t: Ticket, status: TicketStatus, where: "top" | "bottom" = "bottom") => {
      const cols = boardColumns(state, projectId);
      const others = cols[status].filter((x) => x.id !== t.id);
      const position = status === "done" ? undefined : positionForDrop(others, where === "top" ? 0 : others.length);
      const body = { ...(t.status !== status ? { status } : {}), ...(position !== undefined ? { position } : {}) };
      if (!Object.keys(body).length) return;
      dispatch({ type: "event", event: { kind: "ticket.upserted", ticket: { ...t, ...body, updatedAt: t.updatedAt } } });
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
          headerSearchBarOptions: { placeholder: "Filter by key or title", onChangeText: (e) => setFilter(e.nativeEvent.text), hideWhenScrolling: false, autoCapitalize: "none" },
          unstable_headerLeftItems: () => [buttonItem("Projects", "sidebar.left", () => router.push("/projects"))],
          unstable_headerRightItems: () => [
            menuItem("Board options", "ellipsis", [
              ...(hasChildren ? [action(hideChildren ? `Show child tickets (${hiddenCount} hidden)` : "Hide child tickets", hideChildren ? "eye" : "eye.slash", () => setPref("hideChildren", !hideChildren), { state: hideChildren ? "on" : "off" })] : []),
              ...(project ? [action("Project settings", "gearshape", () => router.push({ pathname: "/project/[id]", params: { id: project.id } }))] : []),
              action("Refresh", "arrow.clockwise", () => void onRefresh()),
            ]),
            buttonItem("New session", "plus", () => router.push({ pathname: "/new", params: projectId ? { projectId } : {} }), { variant: "prominent", tintColor: c.accent }),
          ],
        }}
      />
      <ConnectionBanner />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.statusBar}>
        {TICKET_STATUSES.map((s, i) => {
          const on = i === page;
          return (
            <Pressable
              key={s}
              onPress={() => goTo(i)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${STATUS_LABEL[s]}, ${shown[s].length}`}
              style={[styles.statusTab, { backgroundColor: on ? c.bgElev : "transparent", borderColor: on ? c.border : "transparent" }]}
            >
              <StatusDot status={s} />
              <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? "600" : "500", fontSize: 14 }}>{STATUS_LABEL[s]}</Text>
              <Text style={{ color: c.text3, fontSize: 13, fontVariant: ["tabular-nums"] }}>{shown[s].length}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      {hideChildren && hiddenCount > 0 && (
        <Pressable onPress={() => setPref("hideChildren", false)} style={[styles.hiddenNote, { backgroundColor: c.violetSoft }]}>
          <Text style={{ color: c.violet, fontSize: 13 }}>
            {hiddenCount} child ticket{hiddenCount === 1 ? "" : "s"} hidden · Show all
          </Text>
        </Pressable>
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
              contentInsetAdjustmentBehavior="automatic"
              contentContainerStyle={{ padding: 14, paddingBottom: 110, gap: 10 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.text3} />}
              renderItem={({ item }) => <TicketCard ticket={item} state={state} showProject={!projectId} onMove={move} onOpenKey={openKey} />}
              ListEmptyComponent={
                <View style={[styles.emptyCol, { borderColor: c.borderStrong }]}>
                  {total === 0 && status === "planning" && !q ? (
                    <Empty icon="plus" title="No sessions yet">
                      Start one with + in the top right.
                    </Empty>
                  ) : (
                    <Text style={{ color: c.text3, fontSize: 14, textAlign: "center" }}>{q ? "No matches" : COLUMN_EMPTY_TEXT[status]}</Text>
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

const styles = StyleSheet.create({
  statusBar: { paddingHorizontal: 10, paddingVertical: 8, gap: 4 },
  statusTab: { flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, height: 34, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth },
  emptyCol: { borderWidth: 1, borderStyle: "dashed", borderRadius: 12, paddingVertical: 24, paddingHorizontal: 12, alignItems: "center" },
  hiddenNote: { marginHorizontal: 14, marginBottom: 4, paddingVertical: 7, paddingHorizontal: 12, borderRadius: 9, alignItems: "center" },
});
