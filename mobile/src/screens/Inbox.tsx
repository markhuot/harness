// Inbox: triage sessions from watchers, newest first; each opens its outcome + transcript.
import { useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { keyLabel, type Session, type Watcher } from "@harness/shared";
import { dispatchedKey, relativeTime, ticketByKey, TRIAGE_LABEL, triageSessions, watcherStatus } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Badge, Button, Callout, Empty, Spinner, useNow } from "../ui/kit";
import { Markdown } from "../ui/Markdown";
import { FileLinkScope } from "../ui/fileLinks";
import { triageLinkContext } from "../lib/fileViewer";
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
        ListHeaderComponent={
          <>
            <ConnectionBanner />
            <WatcherStrip />
          </>
        }
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

/** Every watcher and what its process is doing now; paused ones are muted, as in Settings. */
function WatcherStrip() {
  const { state } = useStore();
  const c = useColors();
  const now = useNow(1000);
  const watchers = Object.values(state.watchers).sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  if (watchers.length === 0) return null;
  return (
    <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, backgroundColor: c.bgElev }}>
      {watchers.map((w, i) => (
        <WatcherRow key={w.id} watcher={w} now={now} first={i === 0} />
      ))}
    </View>
  );
}

function WatcherRow({ watcher: w, now, first }: { watcher: Watcher; now: number; first: boolean }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const s = watcherStatus(w, now);
  const dot = s.tone === "green" ? c.green : s.tone === "red" ? c.red : c.text3;
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/watcher", params: { id: w.id } })}
      style={({ pressed }) => [styles.watcher, { opacity: w.enabled ? 1 : 0.55, borderTopColor: c.border, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: pressed ? c.bgHover : "transparent" }]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
        <Text style={{ color: c.text, fontSize: 15, fontWeight: "500", flexShrink: 1 }} numberOfLines={1}>
          {w.name}
        </Text>
        <Badge>{w.mode === "loop" ? "Loop" : `Every ${w.intervalSec}s`}</Badge>
        <View style={{ flex: 1 }} />
        <Badge tone={s.tone}>{s.label}</Badge>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 16, gap: 8 }}>
        <Text style={{ color: c.text3, fontSize: 12.5, flex: 1 }} numberOfLines={1}>
          {s.detail}
        </Text>
        {!!s.error && w.live?.state !== "running" && <Button title="Retry now" icon="play" small onPress={() => void act(() => client.runWatcher(w.id), `Restarting ${w.name}`)} />}
      </View>
      {!!s.error && (
        <Pressable onPress={() => setExpanded((v) => !v)} accessibilityRole="button" accessibilityLabel={expanded ? "Show less" : "Show the full error"} style={{ marginLeft: 16, borderRadius: 6, padding: 6, backgroundColor: c.redSoft }}>
          <Text style={{ color: c.red, fontFamily: MONO, fontSize: 11.5 }} numberOfLines={expanded ? undefined : 2}>
            {s.error}
          </Text>
        </Pressable>
      )}
    </Pressable>
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
  // A triage session has no folder of its own: file links resolve where it dispatched to.
  return (
    <FileLinkScope {...triageLinkContext(key, dispatched)}>
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
          {dispatched && <Button title={`Open ${keyLabel(dispatched)}`} icon="chevronRight" small onPress={() => router.push({ pathname: "/ticket/[key]", params: { key: dispatched.key } })} style={{ alignSelf: "flex-start" }} />}
        </View>
        <Transcript sessionId={session.id} emptyHint="The triage agent's reasoning appears here." />
      </View>
    </FileLinkScope>
  );
}

const styles = StyleSheet.create({
  item: { paddingHorizontal: 16, paddingVertical: 12, gap: 5, borderBottomWidth: StyleSheet.hairlineWidth },
  watcher: { paddingHorizontal: 16, paddingVertical: 10, gap: 4 },
});
