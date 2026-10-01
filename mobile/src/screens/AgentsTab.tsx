// The ticket's Agents tab: sub-agents the agent started inside its session (DESIGN.md
// "Sub-agents"), and one sub-agent's own transcript (the "agent:<id>" tab). Same data and labels
// as the desktop (@harness/shared/state).

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Subagent, SubagentStatus, Ticket } from "@harness/shared";
import { groupSubagents, plainText, SUBAGENT_STATUS_LABEL, subagentById, subagentDuration, subagentPath, subagentsOf, subagentTitle, subagentTypeLabel } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO, RADIUS } from "../theme/tokens";
import { Badge, Card, Spinner, toneColors, useNow } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { useHeroScroll } from "../ui/heroCollapse";
import { Transcript } from "./Transcript";

export function SubagentStatusMark({ status }: { status: SubagentStatus }) {
  const c = useColors();
  if (status === "running") return <Spinner />;
  const t = toneColors(c, status === "succeeded" ? "green" : status === "failed" ? "red" : "neutral");
  return (
    <View accessibilityLabel={SUBAGENT_STATUS_LABEL[status]} style={{ width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: t.bg }}>
      <Icon name={status === "succeeded" ? "check" : status === "failed" ? "x" : "stop"} size={11} color={t.fg} strokeWidth={status === "stopped" ? 2 : 3} />
    </View>
  );
}

/** Only shown once the session has sub-agents (effectiveTab falls back to Summaries until then). */
export function AgentsTab({ ticket, onOpen }: { ticket: Ticket; onOpen: (id: string) => void }) {
  const { state } = useStore();
  const c = useColors();
  const list = subagentsOf(state, ticket.sessionId);
  const groups = useMemo(() => groupSubagents(list ?? []), [list]);
  const now = useNow(groups.running.length ? 1000 : 60_000);
  const heroScroll = useHeroScroll();

  const sections = [
    { id: "running", label: "Running", items: groups.running },
    { id: "finished", label: "Finished", items: groups.finished },
  ].filter((s) => s.items.length);
  return (
    <ScrollView {...heroScroll} contentContainerStyle={{ padding: 14, gap: 16, paddingBottom: 30 }}>
      {sections.map((s) => (
        <View key={s.id} style={{ gap: 7 }}>
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 2 }}>
            <Text style={{ color: c.text, fontWeight: "600", fontSize: 14 }}>{s.label}</Text>
            <Text style={{ color: c.text3, fontSize: 13 }}>{s.items.length}</Text>
          </View>
          <Card>
            {s.items.map((a, i) => (
              <AgentRow key={a.id} agent={a} parent={a.parentId ? subagentById(state, ticket.sessionId, a.parentId) : null} now={now} first={i === 0} onOpen={onOpen} />
            ))}
          </Card>
        </View>
      ))}
    </ScrollView>
  );
}

function AgentRow({ agent: a, parent, now, first, onOpen }: { agent: Subagent; parent: Subagent | null; now: number; first: boolean; onOpen: (id: string) => void }) {
  const c = useColors();
  const type = subagentTypeLabel(a);
  const preview = a.status !== "running" && a.result ? a.result : a.prompt;
  return (
    <Pressable
      onPress={() => onOpen(a.id)}
      accessibilityRole="button"
      accessibilityLabel={`${subagentTitle(a)}, ${SUBAGENT_STATUS_LABEL[a.status]}`}
      style={({ pressed }) => ({ padding: 12, gap: 6, backgroundColor: pressed ? c.bgHover : "transparent", borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.border })}
    >
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <SubagentStatusMark status={a.status} />
        <Text style={{ flex: 1, color: a.status === "running" ? c.text : c.text2, fontSize: 14.5, fontWeight: "500" }} numberOfLines={2}>
          {subagentTitle(a)}
        </Text>
        <Text style={{ color: c.text3, fontSize: 12.5, fontVariant: ["tabular-nums"] }}>{subagentDuration(a, now)}</Text>
        <Icon name="chevronRight" size={13} color={c.text3} />
      </View>
      {!!preview && (
        <Text style={{ color: c.text2, fontSize: 13 }} numberOfLines={2}>
          {plainText(preview)}
        </Text>
      )}
      {(type || parent) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {type && (
            <Badge outline>
              <Text style={{ fontFamily: MONO, fontSize: 11.5, color: c.text2 }}>{type}</Text>
            </Badge>
          )}
          {parent && <Text style={{ color: c.text3, fontSize: 12.5 }}>started by {subagentTitle(parent)}</Text>}
        </View>
      )}
    </Pressable>
  );
}

/** One sub-agent: back to the list (through its parents), its task, and its transcript. */
export function SubagentView({ ticket, subagentId, onBack, onOpen }: { ticket: Ticket; subagentId: string; onBack: () => void; onOpen: (id: string) => void }) {
  const { state } = useStore();
  const c = useColors();
  const agent = subagentById(state, ticket.sessionId, subagentId);
  const path = subagentPath(state, ticket.sessionId, subagentId);
  const now = useNow(agent?.status === "running" ? 1000 : 60_000);
  const [promptOpen, setPromptOpen] = useState(false);
  const type = agent ? subagentTypeLabel(agent) : null;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 9, gap: 7, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ alignItems: "center", gap: 4 }}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back to Agents" hitSlop={8} style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <Icon name="chevronLeft" size={14} color={c.accent} />
            <Text style={{ color: c.accent, fontSize: 14.5 }}>Agents</Text>
          </Pressable>
          {path.slice(0, -1).map((p) => (
            <Pressable key={p.id} onPress={() => onOpen(p.id)} accessibilityRole="button" hitSlop={6} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Icon name="chevronRight" size={11} color={c.text3} />
              <Text style={{ color: c.accent, fontSize: 14.5 }} numberOfLines={1}>
                {subagentTitle(p)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        {agent && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <SubagentStatusMark status={agent.status} />
            <Text style={{ flex: 1, color: c.text, fontSize: 16, fontWeight: "600" }} numberOfLines={2}>
              {subagentTitle(agent)}
            </Text>
            <Text style={{ color: c.text3, fontSize: 12.5 }}>
              {SUBAGENT_STATUS_LABEL[agent.status]} · {subagentDuration(agent, now)}
            </Text>
          </View>
        )}
        {type && (
          <View style={{ flexDirection: "row" }}>
            <Badge outline>
              <Text style={{ fontFamily: MONO, fontSize: 11.5, color: c.text2 }}>{type}</Text>
            </Badge>
          </View>
        )}
      </View>
      <Transcript
        sessionId={ticket.sessionId}
        subagentId={subagentId}
        onOpenSubagent={onOpen}
        emptyHint="The sub-agent's conversation will stream in here."
        header={
          agent?.prompt ? (
            <Pressable onPress={() => setPromptOpen(!promptOpen)} accessibilityRole="button" accessibilityState={{ expanded: promptOpen }} style={{ borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.bgElev, padding: 10, gap: 6 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name={promptOpen ? "chevronDown" : "chevronRight"} size={12} color={c.text3} />
                <Text style={{ color: c.text3, fontSize: 11.5, fontWeight: "600", textTransform: "uppercase" }}>Task from the agent</Text>
              </View>
              {promptOpen ? (
                <Markdown text={agent.prompt} size={14} />
              ) : (
                <Text style={{ color: c.text2, fontSize: 14 }} numberOfLines={2}>
                  {plainText(agent.prompt)}
                </Text>
              )}
            </Pressable>
          ) : null
        }
      />
    </View>
  );
}
