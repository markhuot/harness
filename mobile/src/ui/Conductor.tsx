// Conductor presentation shared by the board and ticket detail: segmented progress bar, the
// rollup on a conductor's card and the "Part of" breadcrumb on a child.
import { Pressable, Text, View } from "react-native";
import { keyLabel, type Ticket } from "@harness/shared";
import { progressLabel, progressSegments, type Progress } from "@harness/shared/state";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";
import { Icon } from "./Icon";

export function ProgressBar({ progress, height = 6 }: { progress: Progress; height?: number }) {
  const c = useColors();
  return (
    <View accessibilityLabel={progressLabel(progress)} style={{ flexDirection: "row", gap: 1.5, height, borderRadius: height / 2, backgroundColor: c.bgActive, overflow: "hidden", flex: 1 }}>
      {progressSegments(progress).map((s) => (
        <View key={s.status} style={{ width: `${s.pct}%`, minWidth: 2, backgroundColor: c[s.status], opacity: s.status === "planning" ? 0.45 : 1 }} />
      ))}
    </View>
  );
}

export function ConductorRollup({ progress }: { progress: Progress }) {
  const c = useColors();
  if (!progress.total) return null;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <ProgressBar progress={progress} height={4} />
      <Text style={{ fontSize: 12, color: c.text2, fontWeight: "500", fontVariant: ["tabular-nums"] }}>
        {progress.byStatus.done}/{progress.total} done
      </Text>
      {progress.attention > 0 && (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 7, height: 19, borderRadius: 10, backgroundColor: c.redSoft }}>
          <Icon name="alert" size={10} color={c.red} strokeWidth={2} />
          <Text style={{ fontSize: 11.5, color: c.red, fontWeight: "600" }}>
            {progress.attention} need{progress.attention === 1 ? "s" : ""} you
          </Text>
        </View>
      )}
    </View>
  );
}

export function ParentCrumb({ parent, onOpen }: { parent: Ticket; onOpen: (key: string) => void }) {
  const c = useColors();
  return (
    <Pressable onPress={() => onOpen(parent.key)} accessibilityRole="link" accessibilityLabel={`Part of ${keyLabel(parent)}`} style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 6, opacity: pressed ? 0.6 : 1, alignSelf: "flex-start", maxWidth: "100%" })}>
      <Icon name="conductor" size={12} color={c.violet} />
      <Text style={{ color: c.text3, fontSize: 13 }}>Part of</Text>
      <Text style={{ color: c.text2, fontSize: 13, fontFamily: MONO }}>{keyLabel(parent)}</Text>
      <Text style={{ color: c.text2, fontSize: 13, flexShrink: 1 }} numberOfLines={1}>
        {parent.title || "Untitled"}
      </Text>
      <Icon name="chevronRight" size={12} color={c.text3} />
    </Pressable>
  );
}
