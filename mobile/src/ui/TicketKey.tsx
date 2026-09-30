// A ticket's identifier as the board shows it (DESIGN.md "Remote IDs"): its remote ID when it's
// linked to one, with the local key after it in a muted, smaller face ("MH-62 · MH-124"), so the
// tickets sharing a remote ID stay apart. An unlinked ticket shows its key alone. Routes, copy key
// and branches stay on the local key; this is only the label.

import { Text, type StyleProp, type TextStyle } from "react-native";
import { displayKey, secondaryKey } from "@harness/shared";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";

type Keyed = { key: string; externalRef?: { key: string } | null };

export function TicketKey({ ticket, size = 12.5, color, style, numberOfLines = 1 }: { ticket: Keyed; size?: number; color?: string; style?: StyleProp<TextStyle>; numberOfLines?: number }) {
  const c = useColors();
  const local = secondaryKey(ticket);
  return (
    <Text style={[{ fontFamily: MONO, fontSize: size, color: color ?? (local ? c.text2 : c.text3) }, style]} numberOfLines={numberOfLines}>
      {displayKey(ticket)}
      {local && <Text style={{ color: c.text3, fontSize: size - 1.5, fontWeight: "400" }}> · {local}</Text>}
    </Text>
  );
}
