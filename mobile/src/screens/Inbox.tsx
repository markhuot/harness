// Inbox: triage sessions from watchers, newest first; each opens its outcome + transcript.
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Session } from "@harness/shared";
import { dispatchedKey, relativeTime, ticketByKey, TRIAGE_LABEL, triageSessions } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Badge, Button, Callout, Empty, Spinner, useNow } from "../ui/kit";
import { Markdown } from "../ui/Markdown";
import { Transcript } from "./Transcript";
import { ConnectionBanner } from "./ConnectionBanner";

export function TriageBadge({ session }: { session: Session }) {
  const t = TRIAGE_LABEL[session.triageStatus ?? "triaging"];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {session.busy && <Spinner />}
      <Badge tone={t.tone}>{t.label}</Badge>
    </View>
  );
}

export function InboxScreen() {
  const { state, refresh } = useStore();
  const c = useColors();
  const router = useRouter();
  const now = useNow();
  const sessions = triageSessions(state);
  const [refreshing, setRefreshing] = useState(false);
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: "Inbox", headerLargeTitle: true }} />
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={<ConnectionBanner />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await refresh();
              setRefreshing(false);
            }}
          />
        }
        contentContainerStyle={{ paddingBottom: 100 }}
        ListEmptyComponent={
          <Empty icon="inbox" title="Inbox zero">
            Output from watchers is triaged here before it becomes tickets.
          </Empty>
        }
        renderItem={({ item: s }) => (
          <Pressable onPress={() => router.push({ pathname: "/inbox/[id]", params: { id: s.id } })} style={({ pressed }) => [styles.item, { borderBottomColor: c.border, backgroundColor: pressed ? c.bgHover : "transparent" }]}>
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <Text style={{ fontFamily: MONO, color: c.text3, fontSize: 12.5, flex: 1 }}>{s.key}</Text>
              <Text style={{ color: c.text3, fontSize: 12.5 }}>{relativeTime(s.createdAt, now)}</Text>
            </View>
            <Text style={{ color: c.text, fontSize: 16, fontWeight: "500" }} numberOfLines={2}>
              {s.title || "Untitled item"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TriageBadge session={s} />
              {!!s.outcome && (
                <Text style={{ color: c.text3, fontSize: 13, flex: 1 }} numberOfLines={1}>
                  {s.outcome}
                </Text>
              )}
            </View>
          </Pressable>
        )}
      />
    </View>
  );
}

export function TriageScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state } = useStore();
  const c = useColors();
  const router = useRouter();
  const session = state.sessions[String(id)];
  if (!session)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Empty icon="inbox" title="Not found" />
      </View>
    );
  const key = dispatchedKey(session);
  const dispatched = key ? ticketByKey(state, key) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: session.key }} />
      <View style={{ padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
        <Text style={{ color: c.text, fontSize: 19, fontWeight: "700" }}>{session.title}</Text>
        <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
          <TriageBadge session={session} />
          <Badge outline>{session.driver}</Badge>
        </View>
        {!!session.outcome && (
          <Callout
            tone={session.triageStatus === "dispatched" ? "green" : session.triageStatus === "failed" ? "red" : "neutral"}
            icon={session.triageStatus === "dispatched" ? "checkCircle" : "alert"}
            title="Outcome"
          >
            <Markdown text={session.outcome} size={14} />
          </Callout>
        )}
        {dispatched && <Button title={`Open ${dispatched.key}`} icon="chevronRight" small onPress={() => router.push({ pathname: "/ticket/[key]", params: { key: dispatched.key } })} style={{ alignSelf: "flex-start" }} />}
      </View>
      <Transcript sessionId={session.id} emptyHint="The triage agent's reasoning appears here." />
    </View>
  );
}

const styles = StyleSheet.create({
  item: { paddingHorizontal: 16, paddingVertical: 12, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth },
});
