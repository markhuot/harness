// A theme preview for the Appearance pickers: a tiny board (sidebar, a column with a card, the five
// status dots) drawn in that theme's own tokens, not the current theme's.
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Theme } from "@harness/shared/themes";
import { useColors } from "../state/app";
import { Icon } from "./Icon";

const STATUSES = ["planning", "in_progress", "blocked", "review", "done"] as const;

export function ThemeSwatch({ theme, selected, onPress }: { theme: Theme; selected: boolean; onPress: () => void }) {
  const c = useColors();
  const t = theme.tokens;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected, checked: selected }}
      accessibilityLabel={theme.name}
      testID={`theme-${theme.id}`}
      style={({ pressed }) => [styles.option, { opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.frame, { borderColor: selected ? c.accent : c.border, borderWidth: selected ? 2 : StyleSheet.hairlineWidth, padding: selected ? 0 : 1.5 }]}>
        <View style={[styles.board, { backgroundColor: t.bg }]}>
          <View style={[styles.sidebar, { backgroundColor: t.bgSidebar, borderRightColor: t.border }]}>
            <View style={[styles.navDot, { backgroundColor: t.accent }]} />
            <View style={[styles.navLine, { backgroundColor: t.text3 }]} />
            <View style={[styles.navLine, { backgroundColor: t.text3, width: 10 }]} />
          </View>
          <View style={[styles.column, { backgroundColor: t.bgColumn }]}>
            <View style={styles.dots}>
              {STATUSES.map((s) => (
                <View key={s} style={[styles.dot, { backgroundColor: t[s] }]} />
              ))}
            </View>
            <View style={[styles.card, { backgroundColor: t.bgElev, borderColor: t.border }]}>
              <View style={[styles.line, { backgroundColor: t.text, width: "80%" }]} />
              <View style={[styles.line, { backgroundColor: t.text2, width: "55%" }]} />
              <View style={{ flexDirection: "row", gap: 3, marginTop: 2 }}>
                <View style={[styles.pill, { backgroundColor: t.accent }]} />
                <View style={[styles.pill, { backgroundColor: t.greenSoft, width: 10 }]} />
              </View>
            </View>
          </View>
        </View>
      </View>
      <View style={styles.label}>
        {selected && <Icon name="check" size={12} color={c.accentText} strokeWidth={2.5} />}
        <Text numberOfLines={1} style={{ color: selected ? c.text : c.text2, fontSize: 12, fontWeight: selected ? "600" : "400" }}>
          {theme.name}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  option: { width: 104, gap: 6, alignItems: "center" },
  frame: { width: 104, height: 70, borderRadius: 10 },
  board: { flex: 1, borderRadius: 8, overflow: "hidden", flexDirection: "row" },
  sidebar: { width: 22, paddingTop: 8, paddingHorizontal: 5, gap: 4, borderRightWidth: StyleSheet.hairlineWidth },
  navDot: { width: 12, height: 4, borderRadius: 2, marginBottom: 2 },
  navLine: { width: 12, height: 2.5, borderRadius: 1.25, opacity: 0.8 },
  column: { flex: 1, margin: 5, borderRadius: 5, padding: 4, gap: 4 },
  dots: { flexDirection: "row", gap: 3 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  card: { borderRadius: 4, borderWidth: StyleSheet.hairlineWidth, padding: 4, gap: 3 },
  line: { height: 3, borderRadius: 1.5 },
  pill: { width: 14, height: 5, borderRadius: 2.5 },
  label: { flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 104 },
});
