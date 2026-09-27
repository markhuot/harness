// Ticket detail: header menu (copy key, external link, mark done, cancel, delete), hero (Part-of
// breadcrumb, title, badges, approval card / blocked question, actions), tabs (built-in + plugin)
// and the message composer with the desktop's state-dependent placeholders.

import { useEffect, useMemo, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, useWindowDimensions, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Ticket } from "@harness/shared";
import { childrenOf, COMPOSER_PLACEHOLDER, composerHint, effectiveTab, isReady, isTicketTab, parsePluginTab, pluginTabRoute, TAB_LABEL, TICKET_TABS, type TicketTab } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Badge, Button, Callout, DriverBadge, Empty, KindBadge, ProjectKey, ReviewMark, Spinner, StatusPill } from "../ui/kit";
import { ModelBadge } from "../ui/selects";
import { ParentCrumb } from "../ui/Conductor";
import { Icon } from "../ui/Icon";
import { isIconName } from "@harness/shared/state";
import { confirm } from "../ui/pick";
import { haptic } from "../ui/haptics";
import { action, menuItem } from "../ui/header";
import { ApprovalCard } from "./Approval";
import { Transcript } from "./Transcript";
import { ChildrenTab, DetailsTab, SummariesTab } from "./TicketTabs";
import { BrowserTab } from "./BrowserTab";
import { PluginFrame, usePluginTabs } from "./PluginTab";

export function TicketDetailScreen() {
  const params = useLocalSearchParams<{ key: string; tab?: string }>();
  const ticketKey = String(params.key ?? "");
  const { state, client, dispatch, epoch } = useStore();
  const router = useRouter();
  const c = useColors();
  const [missing, setMissing] = useState(false);
  const ticket = useMemo(() => Object.values(state.tickets).find((t) => t.key === ticketKey), [state.tickets, ticketKey]);
  const pluginTabs = usePluginTabs(ticket);
  const [tab, setTab] = useState<TicketTab>(isTicketTab(params.tab) ? params.tab : "summaries");
  useEffect(() => {
    if (isTicketTab(params.tab)) setTab(params.tab);
  }, [params.tab]);

  useEffect(() => {
    let cancelled = false;
    client
      .getTicket(ticketKey)
      .then((detail) => {
        if (cancelled) return;
        dispatch({ type: "detail", detail });
        // An old key (from before a project rename) resolves to the current key; follow it.
        if (detail.ticket.key !== ticketKey) router.setParams({ key: detail.ticket.key });
      })
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, ticketKey, epoch, router]);

  if (!ticket) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}>
        <Stack.Screen options={{ title: ticketKey }} />
        {missing ? (
          <Empty icon="alert" title={`${ticketKey} not found`}>
            It may have been deleted.
          </Empty>
        ) : (
          <Spinner />
        )}
      </View>
    );
  }

  const shown = effectiveTab(tab, { conductor: ticket.kind === "conductor", pluginTabs });
  const activePlugin = (() => {
    const p = parsePluginTab(shown);
    return p ? pluginTabs?.find((t) => t.pluginId === p.pluginId && t.id === p.tabId) : undefined;
  })();

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }} keyboardVerticalOffset={0}>
      <Header ticket={ticket} />
      <Hero ticket={ticket} compact={shown === "browser" || !!parsePluginTab(shown)} />
      <TabStrip ticket={ticket} tab={shown} onTab={setTab} pluginTabs={pluginTabs} />
      <View style={{ flex: 1 }}>
        {shown === "summaries" && <SummariesTab ticket={ticket} />}
        {shown === "children" && <ChildrenTab ticket={ticket} />}
        {shown === "transcript" && <Transcript sessionId={ticket.sessionId} emptyHint="The agent's conversation will stream in here." />}
        {shown === "browser" && <BrowserTab sessionId={ticket.sessionId} />}
        {shown === "details" && <DetailsTab ticket={ticket} />}
        {activePlugin && <PluginFrame key={`${ticket.key}/${shown}`} ticket={ticket} tab={activePlugin} />}
        {parsePluginTab(shown) && !pluginTabs && (
          <View style={{ padding: 30 }}>
            <Spinner />
          </View>
        )}
      </View>
      {ticket.status !== "done" && <Composer ticket={ticket} key={ticket.id} />}
    </KeyboardAvoidingView>
  );
}

function Header({ ticket }: { ticket: Ticket }) {
  const { client } = useStore();
  const c = useColors();
  const act = useAction();
  const router = useRouter();
  const k = ticket.key;
  const remove = async () => {
    if (!(await confirm(`Delete ${k}?`, "Its transcript and summaries are removed too.", "Delete"))) return;
    const ok = await act(() => client.deleteTicket(k), `${k} deleted`);
    if (ok) router.back();
  };
  return (
    <Stack.Screen
      options={{
        title: k,
        headerTitleStyle: { fontFamily: MONO, color: c.text } as never,
        unstable_headerRightItems: () => [
          menuItem("More", "ellipsis.circle", [
            action("Copy key", "number", () => void Clipboard.setStringAsync(k)),
            ...(ticket.externalRef?.url ? [action(`Open ${ticket.externalRef.key}`, "arrow.up.right.square", () => void Linking.openURL(ticket.externalRef!.url!))] : []),
            ...(ticket.busy ? [action("Cancel run", "stop.circle", () => void act(() => client.cancelTicket(k), "Run cancelled"), { destructive: true })] : []),
            ...(ticket.status !== "done" ? [action("Mark done", "checkmark.circle", () => void act(() => client.completeTicket(k, { skipAgent: true }), `${k} marked done`))] : []),
            action("Delete ticket", "trash", () => void remove(), { destructive: true }),
          ]),
        ],
      }}
    />
  );
}

function Hero({ ticket, compact: compactTab }: { ticket: Ticket; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const compact = compactTab && !expanded;
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const { height } = useWindowDimensions();
  const [changes, setChanges] = useState(false);
  const [completing, setCompleting] = useState(false);
  const children = ticket.kind === "conductor" ? childrenOf(state, ticket.id) : [];
  const project = state.projects[ticket.projectId];
  const parent = ticket.parentId ? state.tickets[ticket.parentId] : undefined;
  const ready = isReady(ticket);
  const k = ticket.key;

  return (
    <ScrollView style={{ maxHeight: height * 0.45, flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }} contentContainerStyle={{ padding: 14, paddingTop: 10, gap: 10 }}>
      {parent && !compact && <ParentCrumb parent={parent} onOpen={(key) => router.push({ pathname: "/ticket/[key]", params: { key, tab: "children" } })} />}
      <Pressable disabled={!compactTab} onPress={() => setExpanded(!expanded)} style={{ flexDirection: "row", alignItems: "center", gap: 8 }} accessibilityRole={compactTab ? "button" : undefined} accessibilityHint={compactTab ? "Shows the ticket's status and actions" : undefined}>
        <Text selectable={!compactTab} numberOfLines={compact ? 1 : undefined} style={{ color: c.text, fontSize: compact ? 16 : 19, fontWeight: "700", lineHeight: compact ? 21 : 25, flex: 1 }}>
          {ticket.title || "Untitled"}
        </Text>
        {compactTab && <Icon name={expanded ? "chevronDown" : "chevronRight"} size={14} color={c.text3} />}
      </Pressable>
      {!compact && (<>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <StatusPill status={ticket.status} />
        {ticket.busy && (
          <Badge tone="amber">
            Working
          </Badge>
        )}
        {project && (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <ProjectKey k={project.key} size="sm" />
            <Text style={{ color: c.text2, fontSize: 13 }}>{project.name}</Text>
          </View>
        )}
        <DriverBadge driver={ticket.driver} />
        <ModelBadge model={ticket.model} driver={ticket.driver} />
        <KindBadge ticket={ticket} childCount={children.length} />
        {ticket.branch && (
          <Badge outline icon="branch">
            {ticket.branch}
          </Badge>
        )}
        {ticket.status === "review" && (
          <>
            <ReviewMark who="agent" state={ticket.agentReview} />
            <ReviewMark who="human" state={ticket.humanReview} />
          </>
        )}
      </View>

      </>)}
      {ticket.pendingApproval && <ApprovalCard key={ticket.pendingApproval.id} ticket={ticket} approval={ticket.pendingApproval} />}
      {!ticket.pendingApproval && ticket.status === "blocked" && ticket.blockedReason && (
        <Callout tone="red" icon="alert" title="The agent needs your input">
          {ticket.blockedReason}
        </Callout>
      )}

      {!compact && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {ticket.status === "planning" && <Button small title="Start work" icon="play" variant="primary" hapticKind="success" onPress={() => void act(() => client.startTicket(k))} />}
        {ticket.status === "review" && ticket.humanReview !== "approved" && (
          <>
            <Button small title="Approve" icon="check" variant="primary" hapticKind="success" onPress={() => void act(() => client.humanReview(k, { decision: "approve" }), "Approved")} />
            <Button small title="Request changes" icon="edit" onPress={() => setChanges(true)} />
          </>
        )}
        {ticket.status === "review" && (
          <>
            <Button small title="Complete" icon="checkCircle" variant={ready ? "primary" : "secondary"} disabled={!ready} onPress={() => setCompleting(true)} accessibilityLabel={ready ? "Complete" : "Complete (needs both agent and human approval)"} />
            <Button small title="Re-run agent review" icon="refresh" variant="ghost" disabled={ticket.busy} onPress={() => void act(() => client.rerunAgentReview(k), "Agent review queued")} />
          </>
        )}
        {ticket.busy && <Button small title="Cancel run" icon="stop" variant="danger" hapticKind="warning" onPress={() => void act(() => client.cancelTicket(k), "Run cancelled")} />}
      </View>}
      {changes && <RequestChanges ticket={ticket} onClose={() => setChanges(false)} />}
      {completing && <Complete ticket={ticket} onClose={() => setCompleting(false)} />}
    </ScrollView>
  );
}

function TabStrip({ ticket, tab, onTab, pluginTabs }: { ticket: Ticket; tab: TicketTab; onTab: (t: TicketTab) => void; pluginTabs: ReturnType<typeof usePluginTabs> }) {
  const { state } = useStore();
  const c = useColors();
  const childCount = ticket.kind === "conductor" ? childrenOf(state, ticket.id).length : 0;
  const summaryCount = state.summaries[ticket.sessionId]?.length ?? 0;
  const items: { id: TicketTab; label: string; count?: number; live?: boolean; icon?: string }[] = [
    ...TICKET_TABS.filter((t) => t !== "children" || ticket.kind === "conductor").map((t) => ({
      id: t as TicketTab,
      label: TAB_LABEL[t],
      count: t === "summaries" ? summaryCount : t === "children" ? childCount : undefined,
      live: t === "transcript" && ticket.busy,
    })),
    ...(pluginTabs ?? []).map((p) => ({ id: pluginTabRoute(p.pluginId, p.id), label: p.title, icon: p.icon ?? undefined })),
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }} contentContainerStyle={{ paddingHorizontal: 8 }}>
      {items.map((it) => {
        const on = it.id === tab;
        return (
          <Pressable
            key={it.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) haptic("select");
              onTab(it.id);
            }}
            style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 11, borderBottomWidth: 2, borderBottomColor: on ? c.accent : "transparent" }}
          >
            {it.icon && isIconName(it.icon) && <Icon name={it.icon} size={13} color={on ? c.text : c.text2} />}
            <Text style={{ color: on ? c.text : c.text2, fontWeight: on ? "600" : "500", fontSize: 14.5 }}>{it.label}</Text>
            {!!it.count && (
              <View style={{ minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: c.bgActive, alignItems: "center", justifyContent: "center" }}>
                <Text style={{ color: c.text2, fontSize: 11.5, fontWeight: "600" }}>{it.count}</Text>
              </View>
            )}
            {it.live && <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: c.in_progress }} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function Composer({ ticket }: { ticket: Ticket }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const ref = useRef<TextInput>(null);
  const hint = composerHint(ticket);
  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const ok = await act(() => client.sendMessage(ticket.key, body));
    setSending(false);
    if (ok) {
      haptic("success");
      setText("");
    }
  };
  const attention = ticket.status === "blocked";
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 8), borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, backgroundColor: c.bgElev, gap: 4 }}>
      {!!hint && <Text style={{ color: c.text3, fontSize: 12, paddingHorizontal: 6 }}>{hint}</Text>}
      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
        <TextInput
          ref={ref}
          multiline
          value={text}
          onChangeText={setText}
          placeholder={COMPOSER_PLACEHOLDER[ticket.status]}
          placeholderTextColor={attention ? c.red : c.text3}
          style={{ flex: 1, maxHeight: 140, minHeight: 40, borderRadius: 20, borderWidth: 1, borderColor: attention ? c.red : c.border, backgroundColor: c.bg, color: c.text, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 10, fontSize: 16 }}
          accessibilityLabel="Message the agent"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!text.trim() || sending}
          onPress={() => void send()}
          style={({ pressed }) => ({ width: 40, height: 40, borderRadius: 20, backgroundColor: c.accent, alignItems: "center", justifyContent: "center", opacity: !text.trim() || sending ? 0.4 : pressed ? 0.7 : 1 })}
        >
          {sending ? <Spinner color="#fff" /> : <Icon name="arrowUp" size={19} color="#fff" strokeWidth={2.5} />}
        </Pressable>
      </View>
    </View>
  );
}

function SheetFrame({ title, subtitle, onClose, children, primary }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; primary: React.ReactNode }) {
  const c = useColors();
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
          <Button title="Cancel" variant="ghost" onPress={onClose} hapticKind={null} />
          <View style={{ flex: 1, alignItems: "center" }}>
            <Text style={{ color: c.text, fontWeight: "600", fontSize: 16 }}>{title}</Text>
            {subtitle && <Text style={{ color: c.text3, fontFamily: MONO, fontSize: 12 }}>{subtitle}</Text>}
          </View>
          {primary}
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </Modal>
  );
}

function RequestChanges({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const [notes, setNotes] = useState("");
  const submit = async () => {
    const ok = await act(() => client.humanReview(ticket.key, { decision: "request_changes", notes }), "Changes requested");
    if (ok) onClose();
  };
  return (
    <SheetFrame title="Request changes" subtitle={ticket.key} onClose={onClose} primary={<Button title="Send" variant="primary" disabled={!notes.trim()} onPress={() => void submit()} />}>
      <TextInput autoFocus multiline placeholder="What should the agent change?" placeholderTextColor={c.text3} value={notes} onChangeText={setNotes} style={{ minHeight: 160, textAlignVertical: "top", borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, padding: 12, fontSize: 16 }} />
      <Text style={{ color: c.text3, fontSize: 13 }}>The ticket moves back to In progress and the agent gets your notes.</Text>
    </SheetFrame>
  );
}

function Complete({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const [instructions, setInstructions] = useState("");
  const [skip, setSkip] = useState(false);
  const submit = async () => {
    const ok = await act(() => client.completeTicket(ticket.key, skip ? { skipAgent: true } : { instructions: instructions.trim() || undefined }), skip ? `${ticket.key} marked done` : "Completion run queued");
    if (ok) {
      haptic("success");
      onClose();
    }
  };
  return (
    <SheetFrame title={`Complete ${ticket.key}`} onClose={onClose} primary={<Button title={skip ? "Mark done" : "Complete"} variant="primary" onPress={() => void submit()} hapticKind={null} />}>
      <Text style={{ color: c.text2, fontSize: 15, lineHeight: 21 }}>The agent finalizes the work: merges the worktree branch, cleans up, and marks the ticket done.</Text>
      <TextInput editable={!skip} multiline placeholder="Optional instructions, e.g. “squash-merge into main and delete the branch”" placeholderTextColor={c.text3} value={instructions} onChangeText={setInstructions} style={{ minHeight: 110, textAlignVertical: "top", borderRadius: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, padding: 12, fontSize: 16, opacity: skip ? 0.5 : 1 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Switch value={skip} onValueChange={setSkip} trackColor={{ true: c.accent }} />
        <Text style={{ color: c.text, fontSize: 15 }}>Just mark it done (no agent run)</Text>
      </View>
    </SheetFrame>
  );
}
