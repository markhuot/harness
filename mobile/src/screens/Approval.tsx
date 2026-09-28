// Tool-permission request: allow once, always allow the tool on this ticket, or deny with a note.
import { useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { PendingApproval, Ticket } from "@harness/shared";
import { approvalToast, describeApprovalInput, relativeTime, shortToolName } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO, RADIUS } from "../theme/tokens";
import { Button, useNow } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { haptic } from "../ui/haptics";

export function ApprovalCard({ ticket, approval }: { ticket: Ticket; approval: PendingApproval }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const now = useNow(10_000);
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showRest, setShowRest] = useState(false);
  const tool = shortToolName(approval.toolName);
  const { primary, description, rest } = describeApprovalInput(approval.toolName, approval.input);

  const answer = async (decision: "allow_once" | "allow_tool" | "deny") => {
    setBusy(decision);
    const ok = await act(() => client.answerApproval(ticket.key, { decision, message: message.trim() || undefined }), approvalToast(decision, tool, ticket.key));
    if (ok) haptic(decision === "deny" ? "warning" : "success");
    setBusy(null);
  };

  return (
    <View accessibilityRole="alert" style={{ borderRadius: RADIUS.lg, borderWidth: 1, borderColor: c.amber, backgroundColor: c.amberSoft, padding: 12, gap: 10 }}>
      <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
        <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c.bgElev, alignItems: "center", justifyContent: "center" }}>
          <Icon name="lock" size={15} color={c.amber} strokeWidth={2} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: c.text, fontSize: 15.5, fontWeight: "600" }}>
            The agent wants to use <Text style={{ fontFamily: MONO }}>{tool}</Text>
          </Text>
          <Text style={{ color: c.text2, fontSize: 13 }}>
            {approval.summary ?? description ?? "Approve to let this run continue."} · requested {relativeTime(approval.requestedAt, now)}
          </Text>
        </View>
      </View>
      {approval.reason && (
        <View style={{ flexDirection: "row", gap: 7, alignItems: "flex-start" }}>
          <Icon name="shield" size={13} color={c.text2} />
          <Text style={{ color: c.text2, fontSize: 13, flex: 1, lineHeight: 18 }}>
            <Text style={{ fontWeight: "600" }}>{approval.source === "classifier" ? "Auto-mode classifier" : "Permission policy"}:</Text> {approval.reason}
          </Text>
        </View>
      )}
      {primary && (
        <View style={{ gap: 4 }}>
          <Text style={{ color: c.text3, fontSize: 11.5, fontWeight: "600", textTransform: "uppercase" }}>{primary.label}</Text>
          <ScrollView horizontal={primary.code} style={{ backgroundColor: c.bgElev, borderRadius: 8, maxHeight: 160 }} contentContainerStyle={{ padding: 9 }}>
            <Text selectable style={{ fontFamily: primary.code ? MONO : undefined, fontSize: 13, color: c.text }}>
              {primary.value}
            </Text>
          </ScrollView>
        </View>
      )}
      {rest && (
        <View>
          <Text onPress={() => setShowRest(!showRest)} style={{ color: c.accentText, fontSize: 13 }}>
            {showRest ? "Hide" : "Show"} {primary ? "other input" : "input"}
          </Text>
          {showRest && (
            <Text selectable style={{ fontFamily: MONO, fontSize: 12, color: c.text2, marginTop: 6 }}>
              {JSON.stringify(rest, null, 2)}
            </Text>
          )}
        </View>
      )}
      {denying && (
        <TextInput
          autoFocus
          multiline
          placeholder="Optional: tell the agent why, or what to do instead"
          placeholderTextColor={c.text3}
          value={message}
          onChangeText={setMessage}
          style={{ minHeight: 64, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, padding: 10, fontSize: 15 }}
        />
      )}
      {denying ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title="Back" variant="ghost" onPress={() => setDenying(false)} disabled={!!busy} />
          <View style={{ flex: 1 }} />
          <Button title="Deny" icon="x" variant="dangerSolid" onPress={() => void answer("deny")} loading={busy === "deny"} hapticKind={null} />
        </View>
      ) : (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button title="Allow once" icon="check" variant="primary" style={{ flex: 1 }} onPress={() => void answer("allow_once")} loading={busy === "allow_once"} disabled={!!busy && busy !== "allow_once"} hapticKind={null} />
            <Button title="Deny…" variant="secondary" onPress={() => setDenying(true)} disabled={!!busy} />
          </View>
          {!approval.onceOnly && (
            <Button title={`Always allow ${tool} on this ticket`} icon="checkCircle" onPress={() => void answer("allow_tool")} loading={busy === "allow_tool"} disabled={!!busy && busy !== "allow_tool"} hapticKind={null} />
          )}
        </View>
      )}
    </View>
  );
}
