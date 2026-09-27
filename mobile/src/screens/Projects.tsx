// The desktop sidebar on a phone: Inbox, All projects and each project with its open count and a
// settings gear; pick one to filter the board. Add a project by its path on the Mac.
import { useMemo } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { sortedProjects, tildify, triageSessions } from "@harness/shared/state";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { displayHost } from "../lib/pair";
import { Card, ProjectKey, SectionTitle } from "../ui/kit";
import { Icon, type IconName } from "../ui/Icon";
import { haptic } from "../ui/haptics";

export function ProjectsScreen() {
  const { state, client, baseUrl } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const projects = sortedProjects(state);
  const openCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of Object.values(state.tickets)) if (t.status !== "done") m[t.projectId] = (m[t.projectId] ?? 0) + 1;
    return m;
  }, [state.tickets]);
  const totalOpen = Object.values(openCounts).reduce((a, b) => a + b, 0);
  const triaging = triageSessions(state).filter((s) => s.triageStatus === "triaging" || s.busy).length;

  const choose = (id: string | null) => {
    haptic("select");
    setPref("boardProject", id);
    router.dismiss();
    router.navigate("/board");
  };
  const addProject = () =>
    Alert.prompt("Add project", "The folder's absolute path on the Mac, e.g. /Users/you/Sites/app", async (path) => {
      if (!path?.trim()) return;
      const p = await act(() => client.createProject({ path: path.trim() }), "Project added");
      if (p) choose(p.id);
    });

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16, gap: 18 }}>
      <Card>
        <NavRow icon="inbox" label="Inbox" badge={triaging || undefined} onPress={() => (router.dismiss(), router.navigate("/inbox"))} />
        <NavRow icon="layers" label="All projects" count={totalOpen} active={!prefs.boardProject} onPress={() => choose(null)} last />
      </Card>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <SectionTitle style={{ flex: 1 }}>Projects</SectionTitle>
          <Pressable onPress={addProject} accessibilityRole="button" accessibilityLabel="Add project" hitSlop={8}>
            <Icon name="plus" size={18} color={c.accent} strokeWidth={2.25} />
          </Pressable>
        </View>
        <Card>
          {projects.map((p, i) => (
            <View key={p.id} style={[styles.row, { borderBottomColor: c.border, borderBottomWidth: i === projects.length - 1 ? 0 : StyleSheet.hairlineWidth, backgroundColor: prefs.boardProject === p.id ? c.accentSoft : "transparent" }]}>
              <Pressable style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }} onPress={() => choose(p.id)} accessibilityRole="button" accessibilityLabel={p.name}>
                <ProjectKey k={p.key} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: c.text, fontSize: 16 }} numberOfLines={1}>
                    {p.name}
                  </Text>
                  <Text style={{ color: c.text3, fontSize: 12, fontFamily: "Menlo" }} numberOfLines={1}>
                    {tildify(p.path)}
                  </Text>
                </View>
                {!!openCounts[p.id] && <Text style={{ color: c.text3, fontSize: 14 }}>{openCounts[p.id]}</Text>}
              </Pressable>
              <Pressable onPress={() => (router.dismiss(), router.push({ pathname: "/project/[id]", params: { id: p.id } }))} hitSlop={10} accessibilityRole="button" accessibilityLabel={`${p.name} settings`} style={{ paddingLeft: 12 }}>
                <Icon name="settings" size={17} color={c.text3} />
              </Pressable>
            </View>
          ))}
          {projects.length === 0 && (
            <Pressable onPress={addProject} style={styles.row}>
              <Icon name="folder" size={16} color={c.accent} />
              <Text style={{ color: c.accent, fontSize: 16 }}>Add a project folder…</Text>
            </Pressable>
          )}
        </Card>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: state.connected ? c.green : c.amber }} />
        <Text style={{ color: c.text2, fontSize: 13, flex: 1 }}>{state.connected ? "Connected" : "Reconnecting…"}</Text>
        <Text style={{ color: c.text3, fontSize: 12, fontFamily: "Menlo" }}>{displayHost(baseUrl)}</Text>
      </View>
    </ScrollView>
  );
}

function NavRow({ icon, label, count, badge, active, onPress, last }: { icon: IconName; label: string; count?: number; badge?: number; active?: boolean; onPress: () => void; last?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.row, { borderBottomColor: c.border, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, backgroundColor: active ? c.accentSoft : pressed ? c.bgHover : "transparent" }]}>
      <Icon name={icon} size={18} color={active ? c.accentText : c.text2} />
      <Text style={{ color: c.text, fontSize: 16, flex: 1 }}>{label}</Text>
      {badge ? (
        <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: c.amber, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
          <Text style={{ color: c.onAmber, fontSize: 12, fontWeight: "700" }}>{badge}</Text>
        </View>
      ) : count ? (
        <Text style={{ color: c.text3, fontSize: 14 }}>{count}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 12, minHeight: 50 },
});
