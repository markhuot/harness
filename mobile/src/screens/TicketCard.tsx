// A board card with everything the desktop card shows. Long-press opens the native context menu
// (move between columns, reorder, copy key); VoiceOver gets the moves as custom actions.

import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { TICKET_STATUSES, type Ticket, type TicketStatus } from "@harness/shared";
import { childrenOf, dependencyStates, dimOnBoard, isReady, latestSummary, plainText, progressOf, shortToolName, STATUS_LABEL, type State } from "@harness/shared/state";
import { useColors } from "../state/app";
import { MONO, RADIUS } from "../theme/tokens";
import { Badge, Chip, DriverBadge, KindBadge, ProjectKey, ReviewMark, Spinner } from "../ui/kit";
import { ModelBadge } from "../ui/selects";
import { ConductorRollup } from "../ui/Conductor";
import { Icon } from "../ui/Icon";
import { haptic } from "../ui/haptics";
import { pick } from "../ui/pick";


export interface CardProps {
  ticket: Ticket;
  state: State;
  showProject: boolean;
  onMove: (t: Ticket, status: TicketStatus, where?: "top" | "bottom") => void;
  onOpenKey: (key: string) => void;
}

export const TicketCard = memo(function TicketCard({ ticket: t, state, showProject, onMove, onOpenKey }: CardProps) {
  const c = useColors();
  const deps = dependencyStates(state, t);
  const children = t.kind === "conductor" ? childrenOf(state, t.id) : [];
  const progress = t.kind === "conductor" ? progressOf(children) : null;
  const dim = dimOnBoard(t);
  const summary = latestSummary(state, t.sessionId);
  const ready = isReady(t);
  const project = state.projects[t.projectId];
  const parent = t.parentId ? state.tickets[t.parentId] : undefined;

  const body = (
    <View
      style={[
        styles.card,
        { backgroundColor: c.bgElev, borderColor: c.border },
        dim && { backgroundColor: c.bgColumn, paddingVertical: 9, gap: 5 },
        t.kind === "conductor" && { borderLeftWidth: 3, borderLeftColor: c.violet },
      ]}
    >
      <View style={styles.top}>
        <Text style={[styles.key, { color: c.text3 }]}>{t.key}</Text>
        {parent && (
          <View style={[styles.parentChip, { backgroundColor: c.violetSoft }]}>
            <Text style={{ fontSize: 11, color: c.violet, fontFamily: MONO }} numberOfLines={1}>
              ↳ {parent.key}
            </Text>
          </View>
        )}
        <View style={{ flex: 1 }} />
        {t.status === "review" && (
          <View style={{ flexDirection: "row", gap: 3 }}>
            <ReviewMark who="agent" state={t.agentReview} />
            <ReviewMark who="human" state={t.humanReview} />
          </View>
        )}
        {t.busy && <Spinner />}
        {t.externalRef && <Badge icon="link">{t.externalRef.source}</Badge>}
      </View>
      <Text style={[styles.title, { color: dim ? c.text2 : c.text, fontSize: dim ? 14.5 : 15.5 }]} numberOfLines={dim ? 2 : 3}>
        {t.title || "Untitled"}
      </Text>

      {t.pendingApproval ? (
        <View style={[styles.note, { backgroundColor: c.amberSoft }]}>
          <Icon name="lock" size={12} color={c.amber} strokeWidth={2} />
          <Text style={{ color: c.amber, fontSize: 13, flex: 1 }} numberOfLines={2}>
            Needs approval: <Text style={{ fontFamily: MONO, fontWeight: "600" }}>{shortToolName(t.pendingApproval.toolName)}</Text>
          </Text>
        </View>
      ) : (
        t.status === "blocked" &&
        t.blockedReason && (
          <View style={[styles.note, { backgroundColor: c.redSoft }]}>
            <Icon name="alert" size={12} color={c.red} strokeWidth={2} />
            <Text style={{ color: c.red, fontSize: 13, flex: 1, lineHeight: 18 }} numberOfLines={3}>
              {t.blockedReason}
            </Text>
          </View>
        )
      )}
      {summary && t.status !== "blocked" && !t.pendingApproval && (
        <Text style={{ color: dim ? c.text3 : c.text2, fontSize: 13.5, lineHeight: 19 }} numberOfLines={dim ? 1 : 2}>
          {plainText(summary.body)}
        </Text>
      )}

      {progress && <ConductorRollup progress={progress} />}

      {deps.length > 0 && (
        <View style={styles.wrap}>
          {deps.map((d) => (
            <Chip key={d.key} label={d.key} done={d.done} />
          ))}
        </View>
      )}

      <View style={styles.wrap}>
        {showProject && project && <ProjectKey k={project.key} size="sm" />}
        {!dim && <DriverBadge driver={t.driver} />}
        <ModelBadge model={t.model} driver={t.driver} />
        <KindBadge ticket={t} />
        <View style={{ flex: 1 }} />
        {ready && (
          <Badge tone="green" icon="check">
            Ready
          </Badge>
        )}
      </View>
    </View>
  );

  const menu = async () => {
    haptic("heavy");
    const v = await pick<string>({
      title: `${t.key} · ${t.title}`.slice(0, 90),
      choices: [
        ...TICKET_STATUSES.filter((st) => st !== t.status).map((st) => ({ value: `move:${st}`, label: `Move to ${STATUS_LABEL[st]}` })),
        ...(t.status !== "done" ? [{ value: "top", label: "Move to top" }, { value: "bottom", label: "Move to bottom" }] : []),
        ...(parent ? [{ value: "parent", label: `Open ${parent.key}` }] : []),
        { value: "copy", label: "Copy key" },
      ],
    });
    if (!v) return;
    if (v.startsWith("move:")) {
      haptic("success");
      onMove(t, v.slice(5) as TicketStatus);
    } else if (v === "top" || v === "bottom") onMove(t, t.status, v);
    else if (v === "parent" && parent) onOpenKey(parent.key);
    else if (v === "copy") void Clipboard.setStringAsync(t.key);
  };

  return (
    <Pressable
      onPress={() => onOpenKey(t.key)}
      onLongPress={() => void menu()}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${t.key} ${t.title}${t.pendingApproval ? ", needs approval" : t.status === "blocked" ? ", blocked" : ""}`}
      accessibilityHint="Opens the ticket. Touch and hold to move it."
      accessibilityActions={TICKET_STATUSES.filter((st) => st !== t.status).map((st) => ({ name: `move:${st}`, label: `Move to ${STATUS_LABEL[st]}` }))}
      onAccessibilityAction={(e) => e.nativeEvent.actionName.startsWith("move:") && onMove(t, e.nativeEvent.actionName.slice(5) as TicketStatus)}
      style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.985 : 1 }] })}
    >
      {body}
    </Pressable>
  );
}, cardPropsEqual);

function cardPropsEqual(a: CardProps, b: CardProps) {
  if (a.ticket !== b.ticket || a.showProject !== b.showProject || a.onMove !== b.onMove) return false;
  const s1 = a.state;
  const s2 = b.state;
  if (s1.summaries[a.ticket.sessionId] !== s2.summaries[b.ticket.sessionId]) return false;
  if (s1.projects !== s2.projects) return false;
  if (s1.tickets !== s2.tickets && (a.ticket.dependsOn.length || a.ticket.kind === "conductor" || a.ticket.parentId)) return false;
  return true;
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.lg, padding: 13, gap: 8 },
  top: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 21 },
  key: { fontFamily: MONO, fontSize: 12.5 },
  parentChip: { paddingHorizontal: 6, height: 19, borderRadius: 5, justifyContent: "center", maxWidth: 120 },
  title: { fontWeight: "500", lineHeight: 21 },
  note: { flexDirection: "row", gap: 7, alignItems: "flex-start", borderRadius: RADIUS.sm + 2, paddingVertical: 7, paddingHorizontal: 9 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 5, alignItems: "center" },
});
