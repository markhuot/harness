// Ticket detail tab bodies: Summaries, Tickets (conductor children) and Details.

import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { keyLabel, type Ticket } from "@harness/shared";
import {
  attentionOf,
  childrenOfTicket,
  dependencyStates,
  dependentsOf,
  driverLabel,
  groupChildren,
  hasCustomDriver,
  latestSummary,
  plainText,
  progressLabel,
  progressOf,
  relativeTime,
  shortToolName,
  STATUS_LABEL,
} from "@harness/shared/state";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Badge, Button, Card, Chip, DriverBadge, Empty, ReviewMark, SectionTitle, Spinner, StatusDot, useNow } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { AttachmentRow } from "../ui/Attachments";
import { Markdown } from "../ui/Markdown";
import { ProgressBar } from "../ui/Conductor";
import { useStickToBottom } from "../ui/stickToBottom";
import { Prop } from "../ui/Prop";
import { TicketSettings } from "../ui/TicketSettings";
import { TicketKey } from "../ui/TicketKey";
import { RelatedTicketRows } from "../ui/RelatedTickets";
import { relatedOf } from "../lib/related";

export function useOpenTicket() {
  const router = useRouter();
  return (key: string, tab?: string) => router.push({ pathname: "/ticket/[key]", params: tab ? { key, tab } : { key } });
}

// ---------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------

export function SummariesTab({ ticket }: { ticket: Ticket }) {
  const { state } = useStore();
  const c = useColors();
  const now = useNow();
  const open = useOpenTicket();
  const list = state.summaries[ticket.sessionId] ?? [];
  const deps = dependencyStates(state, ticket);
  // Newest is last; open scrolled to it and follow new summaries until the user scrolls up.
  const stick = useStickToBottom<ScrollView>();
  return (
    <ScrollView {...stick} contentContainerStyle={{ padding: 14, gap: 14, paddingBottom: 30 }} keyboardDismissMode="interactive">
      {!!ticket.description && (
        <Card style={{ padding: 13, gap: 8 }}>
          <SectionTitle>{ticket.status === "planning" ? "Plan" : "Brief"}</SectionTitle>
          <Markdown text={ticket.description} />
        </Card>
      )}
      {deps.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <SectionTitle>Depends on</SectionTitle>
          {deps.map((d) => (
            <Chip key={d.key} label={d.ticket ? keyLabel(d.ticket) : d.key} done={d.done} unknown={d.state === "unknown"} onPress={d.missing ? undefined : () => open(d.ticket?.key ?? d.key)} />
          ))}
        </View>
      )}
      {list.length === 0 ? (
        <Empty icon="fileText" title="No summaries yet">
          The agent posts short progress updates here as it works.
        </Empty>
      ) : (
        list.map((s) => (
          <View key={s.id} style={{ flexDirection: "row", gap: 10 }}>
            <View style={{ width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: s.author === "human" ? c.bgActive : s.author === "system" ? c.amberSoft : c.accentSoft }}>
              <Icon name={s.author === "human" ? "user" : s.author === "system" ? "zap" : "sparkle"} size={12} color={s.author === "human" ? c.text2 : s.author === "system" ? c.amber : c.accent} strokeWidth={2} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={{ flexDirection: "row", gap: 8, alignItems: "baseline" }}>
                <Text style={{ color: c.text, fontWeight: "600", fontSize: 14 }}>{s.author === "agent" ? "Agent" : s.author === "human" ? "You" : "Harness"}</Text>
                <Text style={{ color: c.text3, fontSize: 12.5 }}>{relativeTime(s.createdAt, now)}</Text>
              </View>
              <Markdown text={s.body} />
              {s.attachments?.length > 0 && <AttachmentRow attachments={s.attachments} />}
            </View>
          </View>
        ))
      )}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// Tickets (conductor children)
// ---------------------------------------------------------------------------

export function ChildrenTab({ ticket }: { ticket: Ticket }) {
  const { state, client, dispatch, epoch } = useStore();
  const c = useColors();
  const open = useOpenTicket();
  const children = useMemo(() => childrenOfTicket(state.tickets, ticket.id), [state.tickets, ticket.id]);
  const progress = useMemo(() => progressOf(children), [children]);
  const groups = useMemo(() => groupChildren(children), [children]);

  const fetched = useRef(new Set<string>());
  useEffect(() => {
    for (const ch of children) {
      if (state.summaries[ch.sessionId] || fetched.current.has(ch.id)) continue;
      fetched.current.add(ch.id);
      client
        .listSummaries(ch.key)
        .then((summaries) => dispatch({ type: "summaries", sessionId: ch.sessionId, summaries }))
        .catch(() => {});
    }
  }, [children, client, dispatch, state.summaries]);
  useEffect(() => fetched.current.clear(), [epoch]);

  // Until the conductor's detail lands, only its unfinished children are known (done ones page in).
  const complete = !!state.childrenLoaded[ticket.id];
  if (!children.length && !complete)
    return (
      <View style={{ padding: 30 }}>
        <Spinner />
      </View>
    );
  if (!children.length)
    return (
      <Empty icon="conductor" title="No tickets yet">
        The conductor hasn't created any tickets yet.
      </Empty>
    );

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 16, paddingBottom: 30 }}>
      <Card style={{ padding: 13, gap: 9 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text style={{ color: c.text, fontSize: 14.5, fontWeight: "500", flex: 1 }}>{progressLabel(progress)}</Text>
          {!complete && <Spinner />}
        </View>
        <View style={{ flexDirection: "row" }}>
          <ProgressBar progress={progress} />
        </View>
        {progress.attention > 0 && (
          <View style={{ flexDirection: "row", gap: 5, alignItems: "center" }}>
            <Icon name="alert" size={12} color={c.red} strokeWidth={2} />
            <Text style={{ color: c.red, fontSize: 13.5 }}>
              {progress.attention} ticket{progress.attention === 1 ? "" : "s"} waiting on you
            </Text>
          </View>
        )}
      </Card>
      {groups.map((g) => (
        <View key={g.status} style={{ gap: 7 }}>
          <View style={{ flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 2 }}>
            <StatusDot status={g.status} />
            <Text style={{ color: c.text, fontWeight: "600", fontSize: 14 }}>{STATUS_LABEL[g.status]}</Text>
            <Text style={{ color: c.text3, fontSize: 13 }}>{g.tickets.length}</Text>
          </View>
          <Card>
            {g.tickets.map((ch, i) => (
              <ChildRow key={ch.id} child={ch} onOpen={open} first={i === 0} />
            ))}
          </Card>
        </View>
      ))}
    </ScrollView>
  );
}

function ChildRow({ child: ch, onOpen, first }: { child: Ticket; onOpen: (key: string) => void; first: boolean }) {
  const { state } = useStore();
  const c = useColors();
  const deps = dependencyStates(state, ch);
  const summary = latestSummary(state, ch.sessionId);
  const attention = attentionOf(ch);
  const showDriver = hasCustomDriver(state, ch);
  return (
    <Pressable
      onPress={() => onOpen(ch.key)}
      style={({ pressed }) => [
        { padding: 12, gap: 6, backgroundColor: pressed ? c.bgHover : "transparent", borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.border },
        attention && { borderLeftWidth: 3, borderLeftColor: attention === "approval" ? c.amber : c.red },
        ch.status === "done" && { opacity: 0.7 },
      ]}
    >
      <View style={{ flexDirection: "row", gap: 7, alignItems: "center" }}>
        <TicketKey ticket={ch} style={{ flexShrink: 1, maxWidth: "45%" }} />
        <Text style={{ flex: 1, color: c.text, fontSize: 14.5, fontWeight: "500" }} numberOfLines={2}>
          {ch.title || "Untitled"}
        </Text>
        {ch.busy && <Spinner />}
        {ch.status === "review" && (
          <View style={{ flexDirection: "row", gap: 3 }}>
            <ReviewMark who="agent" state={ch.agentReview} />
            <ReviewMark who="human" state={ch.humanReview} />
          </View>
        )}
      </View>
      {ch.pendingApproval ? (
        <Text style={{ color: c.amber, fontSize: 13 }}>
          <Icon name="lock" size={11} color={c.amber} /> Needs approval: <Text style={{ fontFamily: MONO }}>{shortToolName(ch.pendingApproval.toolName)}</Text>
        </Text>
      ) : ch.status === "blocked" ? (
        <Text style={{ color: c.red, fontSize: 13 }} numberOfLines={3}>
          {ch.blockedReason || "Blocked"}
        </Text>
      ) : (
        summary && (
          <Text style={{ color: c.text2, fontSize: 13 }} numberOfLines={2}>
            {plainText(summary.body)}
          </Text>
        )
      )}
      {(deps.length > 0 || showDriver || ch.model) && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          {deps.map((d) => (
            <Chip key={d.key} label={d.ticket ? keyLabel(d.ticket) : d.key} prefix={d.done ? "after" : "waiting on"} done={d.done} unknown={d.state === "unknown"} onPress={d.missing ? undefined : () => onOpen(d.ticket?.key ?? d.key)} />
          ))}
          <View style={{ flex: 1 }} />
          {showDriver && <DriverBadge driver={ch.driver} />}
          {ch.model && <Badge outline>{ch.model}</Badge>}
        </View>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export function DetailsTab({ ticket }: { ticket: Ticket }) {
  const { state, client, related: fetchedRelated } = useStore();
  const act = useAction();
  const c = useColors();
  const now = useNow();
  const open = useOpenTicket();
  const related = useMemo(() => relatedOf(state.tickets, ticket, fetchedRelated.byTicket[ticket.id]), [state.tickets, ticket, fetchedRelated.byTicket]);
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description);
  useEffect(() => setTitle(ticket.title), [ticket.title]);
  useEffect(() => setDescription(ticket.description), [ticket.description]);

  // The detail's list covers done dependents that aren't loaded; the live scan covers new ones.
  const dependents = useMemo(() => dependentsOf(state, ticket), [state.tickets, state.dependents, state.keyAliases, ticket]); // eslint-disable-line react-hooks/exhaustive-deps
  const runs = useMemo(() => Object.values(state.runs).filter((r) => r.sessionId === ticket.sessionId).sort((a, b) => b.createdAt - a.createdAt), [state.runs, ticket.sessionId]);
  const editable = ticket.status !== "done";

  const saveTitle = () => {
    if (title.trim() && title !== ticket.title) void act(() => client.updateTicket(ticket.key, { title: title.trim() }));
  };
  const descDirty = description !== ticket.description;

  const input = { borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, borderRadius: 9, paddingHorizontal: 11, paddingVertical: 9, fontSize: 15.5 } as const;

  return (
    <ScrollView contentContainerStyle={{ padding: 14, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
      <Field label="Title">
        <TextInput style={input} value={title} editable={editable} onChangeText={setTitle} onBlur={saveTitle} onSubmitEditing={saveTitle} returnKeyType="done" />
      </Field>
      <Field label={ticket.status === "planning" ? "Plan / brief" : "Brief"}>
        <TextInput style={[input, { minHeight: 120, textAlignVertical: "top", fontSize: 14.5, lineHeight: 20 }]} multiline value={description} editable={editable} onChangeText={setDescription} />
        {descDirty && (
          <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Text style={{ color: c.text3, flex: 1, fontSize: 13 }}>Unsaved changes</Text>
            <Button small title="Revert" variant="ghost" onPress={() => setDescription(ticket.description)} />
            <Button small title="Save" variant="primary" onPress={() => void act(() => client.updateTicket(ticket.key, { description }), "Saved")} />
          </View>
        )}
      </Field>
      <Card>
        <TicketSettings ticket={ticket} onPatch={(patch) => void act(() => client.updateTicket(ticket.key, patch))} />
        {dependents.length > 0 && (
          <Prop label="Blocks">
            <View style={{ gap: 6, alignItems: "flex-end" }}>
              {dependents.map((d) => (
                <Pressable key={d.key} onPress={() => open(d.key)} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                  {d.ticket && <StatusDot status={d.ticket.status} />}
                  <Text style={{ fontFamily: MONO, color: c.accentText, fontSize: 13.5 }}>{d.ticket ? keyLabel(d.ticket) : d.key}</Text>
                </Pressable>
              ))}
            </View>
          </Prop>
        )}
        <Prop label="Workdir">
          <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, color: ticket.workdir ? c.text : c.text3, textAlign: "right", flexShrink: 1 }}>
            {ticket.workdir ?? "Not prepared yet"}
          </Text>
        </Prop>
        {ticket.pullRequestUrl && (
          <Prop label="Pull request">
            <Text style={{ color: c.accentText, fontSize: 14, flexShrink: 1, textAlign: "right" }} numberOfLines={1} ellipsizeMode="middle" accessibilityRole="link" onPress={() => void Linking.openURL(ticket.pullRequestUrl!)}>
              {ticket.pullRequestUrl.replace(/^https?:\/\//, "")}
            </Text>
          </Prop>
        )}
        {ticket.externalRef && (
          <Prop label="External">
            <Text
              style={{ color: ticket.externalRef.url ? c.accentText : c.text, fontSize: 14, fontFamily: MONO, textAlign: "right", flexShrink: 1 }}
              accessibilityRole={ticket.externalRef.url ? "link" : undefined}
              onPress={ticket.externalRef.url ? () => void Linking.openURL(ticket.externalRef!.url!) : undefined}
            >
              {ticket.externalRef.key}
              {ticket.externalRef.url ? " ↗" : ""}
              <Text style={{ color: c.text3, fontFamily: undefined }}> · {ticket.externalRef.source === "manual" ? "set by hand" : `via ${ticket.externalRef.source}`}</Text>
            </Text>
          </Prop>
        )}
        {related.length > 0 && (
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
            <Text style={{ color: c.text2, fontSize: 14, paddingHorizontal: 13, paddingTop: 11, paddingBottom: 4 }}>{ticket.externalRef ? `Also linked to ${ticket.externalRef.key}` : `Linked to remote ID ${ticket.key}`}</Text>
            <RelatedTicketRows related={related} onOpen={(key) => open(key)} />
          </View>
        )}
        <Prop label="Allowed tools">
          {ticket.allowedTools.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end", flexShrink: 1 }}>
              {ticket.allowedTools.map((tool) => (
                <Chip key={tool} label={tool} done />
              ))}
            </View>
          ) : (
            <Text style={{ color: c.text3, fontSize: 14 }}>None granted</Text>
          )}
        </Prop>
        <Prop label="Auto-start">
          <Text style={{ color: ticket.autoStart ? c.text : c.text3, fontSize: 14 }}>{ticket.autoStart ? "When dependencies are done" : "Off"}</Text>
        </Prop>
        <Prop label="Created">
          <Text style={{ color: c.text, fontSize: 14 }}>{relativeTime(ticket.createdAt, now)}</Text>
        </Prop>
        <Prop label="Updated" last>
          <Text style={{ color: c.text, fontSize: 14 }}>{relativeTime(ticket.updatedAt, now)}</Text>
        </Prop>
      </Card>

      {runs.length > 0 && (
        <View style={{ gap: 8 }}>
          <SectionTitle>Runs</SectionTitle>
          <Card>
            {runs.map((r, i) => (
              <View key={r.id} style={{ padding: 11, gap: 3, borderTopWidth: i ? StyleSheet.hairlineWidth : 0, borderTopColor: c.border }}>
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                  {(r.status === "running" || r.status === "queued") && <Spinner />}
                  <Text style={{ fontSize: 13, fontWeight: "600", color: r.status === "failed" ? c.red : r.status === "succeeded" ? c.green : c.text2 }}>{r.status}</Text>
                  <Text style={{ fontSize: 13, color: c.text }}>{r.kind}</Text>
                  <Text style={{ fontSize: 13, color: c.text3 }}>{driverLabel(r.driver, state.drivers)}</Text>
                  <View style={{ flex: 1 }} />
                  <Text style={{ fontSize: 12.5, color: c.text3 }}>{r.startedAt && r.endedAt ? `${Math.max(1, Math.round((r.endedAt - r.startedAt) / 1000))}s` : relativeTime(r.createdAt, now)}</Text>
                </View>
                <Text style={{ fontSize: 13, color: r.error ? c.red : c.text3 }} numberOfLines={2}>
                  {r.error ?? r.prompt.split("\n")[0]}
                </Text>
              </View>
            ))}
          </Card>
        </View>
      )}
    </ScrollView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.text2, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      {children}
    </View>
  );
}
