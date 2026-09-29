// One label / value row of a settings card (ticket Details, a draft's Options): the label with an
// optional hint on the left, the control on the right, and an optional line underneath (the branch
// hint, a dependency error) that spans the row.

import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useColors } from "../state/app";

export function Prop({ label, hint, children, footer, last }: { label: string; hint?: string; children: ReactNode; footer?: ReactNode; last?: boolean }) {
  const c = useColors();
  return (
    <View style={{ paddingHorizontal: 13, paddingVertical: 11, gap: 6, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border, minHeight: 48, justifyContent: "center" }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ minWidth: 90 }}>
          <Text style={{ color: c.text2, fontSize: 14 }}>{label}</Text>
          {hint && <Text style={{ color: c.text3, fontSize: 11.5 }}>{hint}</Text>}
        </View>
        <View style={{ flex: 1, alignItems: "flex-end" }}>{children}</View>
      </View>
      {footer}
    </View>
  );
}
