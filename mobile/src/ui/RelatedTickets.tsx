// The tickets that share a remote ID (lib/related), as rows that open each one: under a ticket's
// External row in Details, and on the "Remote ID" screen a remote-only key opens to.

import { Pressable, StyleSheet, Text, View } from "react-native";
import type { RelatedTicket } from "@harness/shared";
import { STATUS_LABEL } from "@harness/shared/state";
import { useColors } from "../state/app";
import { StatusDot } from "./kit";
import { Icon } from "./Icon";
import { TicketKey } from "./TicketKey";

const keyed = (r: RelatedTicket) => ({ key: r.key, externalRef: { key: r.externalKey } });

export function RelatedTicketRows({ related, onOpen, dividerFirst }: { related: RelatedTicket[]; onOpen: (key: string) => void; dividerFirst?: boolean }) {
  const c = useColors();
  return (
    <>
      {related.map((r, i) => (
        <Pressable
          key={r.key}
          onPress={() => onOpen(r.key)}
          accessibilityRole="link"
          accessibilityLabel={`${r.key} ${r.title || "Untitled"}, ${STATUS_LABEL[r.status]}`}
          style={({ pressed }) => [styles.row, { borderTopColor: c.border, borderTopWidth: i || dividerFirst ? StyleSheet.hairlineWidth : 0, backgroundColor: pressed ? c.bgHover : "transparent" }]}
        >
          <StatusDot status={r.status} />
          <View style={{ flex: 1, gap: 1 }}>
            <TicketKey ticket={keyed(r)} size={12.5} />
            <Text style={{ color: c.text, fontSize: 14.5 }} numberOfLines={2}>
              {r.title || "Untitled"}
            </Text>
          </View>
          <Icon name="chevronRight" size={12} color={c.text3} />
        </Pressable>
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 13, paddingVertical: 10 },
});
