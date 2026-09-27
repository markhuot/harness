// A session's conversation: REST backfill merged with live transcript.appended events, the
// streaming delta of the current run, tool calls paired with their results as collapsible rows,
// and permission audit rows. Sticks to the bottom while you're there.

import { memo, useEffect, useMemo, useState } from "react";
import { FlatList, Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { PermissionDecisionLog, ToolResultContent, TranscriptEntry } from "@harness/shared";
import { decisionSource, formatMaybeJson, groupTranscript, liveDelta, permissionVerb, shortToolName, toolIcon, toolPreview, type ToolCallEntry, type ToolResultEntry, type TranscriptItem } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO, RADIUS } from "../theme/tokens";
import { Empty, Spinner } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { Markdown } from "../ui/Markdown";
import { useStickToBottom } from "../ui/stickToBottom";

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

type Row = TranscriptItem | { kind: "delta"; runId: string; text: string } | { kind: "working" };

export function Transcript({ sessionId, emptyHint }: { sessionId: string; emptyHint?: string }) {
  const { state, client, dispatch, epoch } = useStore();
  const c = useColors();
  const [error, setError] = useState<string | null>(null);
  const transcript = state.transcripts[sessionId];
  const deltas = liveDelta(state, sessionId);
  const session = state.sessions[sessionId];

  useEffect(() => {
    let cancelled = false;
    setError(null);
    client
      .transcript(sessionId, 0)
      .then((entries) => !cancelled && dispatch({ type: "transcript", sessionId, entries }))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [client, dispatch, sessionId, epoch]);

  const items = useMemo(() => groupTranscript(transcript?.entries ?? []), [transcript?.entries]);
  const rows: Row[] = useMemo(() => {
    const r: Row[] = [...items, ...deltas.map((d) => ({ kind: "delta" as const, ...d }))];
    if (session?.busy && deltas.length === 0) r.push({ kind: "working" });
    return r;
  }, [items, deltas, session?.busy]);

  const stick = useStickToBottom<FlatList<Row>>();
  const loading = !transcript?.loaded && !error;

  return (
    <FlatList
      {...stick}
      data={rows}
      keyExtractor={(r, i) => (r.kind === "tool" ? r.call.id : r.kind === "entry" ? r.entry.id : r.kind === "delta" ? `delta-${r.runId}` : `working-${i}`)}
      renderItem={({ item }) => <RowView row={item} />}
      contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 24 }}
      keyboardDismissMode="interactive"
      ListHeaderComponent={
        error ? (
          <View style={{ flexDirection: "row", gap: 6, padding: 10, borderRadius: 8, backgroundColor: c.redSoft }}>
            <Icon name="alert" size={14} color={c.red} />
            <Text style={{ color: c.red, flex: 1 }}>Couldn't load the transcript: {error}</Text>
          </View>
        ) : null
      }
      ListEmptyComponent={
        loading ? (
          <View style={{ padding: 30 }}>
            <Spinner />
          </View>
        ) : (
          <Empty icon="message" title="No messages yet">
            {emptyHint}
          </Empty>
        )
      }
    />
  );
}

function RowView({ row }: { row: Row }) {
  const c = useColors();
  if (row.kind === "tool") return <ToolRow call={row.call} result={row.result} />;
  if (row.kind === "entry") return <EntryRow entry={row.entry} />;
  if (row.kind === "delta")
    return (
      <View style={{ gap: 4 }}>
        <Who icon="sparkle" label="Agent" />
        <Text style={{ color: c.text, fontSize: 15, lineHeight: 22 }} selectable>
          {row.text}
          <Text style={{ color: c.accent }}>▍</Text>
        </Text>
      </View>
    );
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 4 }}>
      <Spinner />
      <Text style={{ color: c.text3, fontSize: 14 }}>Working…</Text>
    </View>
  );
}

function Who({ icon, label, time }: { icon: "sparkle" | "user"; label: string; time?: string }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      <Icon name={icon} size={12} color={icon === "sparkle" ? c.accent : c.text2} strokeWidth={2} />
      <Text style={{ color: c.text2, fontSize: 12.5, fontWeight: "600" }}>{label}</Text>
      {time && <Text style={{ color: c.text3, fontSize: 12 }}>{time}</Text>}
    </View>
  );
}

const EntryRow = memo(function EntryRow({ entry }: { entry: TranscriptEntry }) {
  const c = useColors();
  const ct = entry.content;
  const time = timeOf(entry.createdAt);
  switch (ct.type) {
    case "text":
      if (entry.role === "user")
        return (
          <View style={{ alignItems: "flex-end", gap: 4 }}>
            <Who icon="user" label="You" time={time} />
            <View style={{ backgroundColor: c.accentSoft, borderRadius: 14, borderTopRightRadius: 4, padding: 11, maxWidth: "92%" }}>
              <Markdown text={ct.text} />
            </View>
          </View>
        );
      if (entry.role === "system")
        return (
          <View style={{ paddingHorizontal: 6 }}>
            <Markdown text={ct.text} size={13.5} color={c.text2} />
          </View>
        );
      return (
        <View style={{ gap: 4 }}>
          <Who icon="sparkle" label="Agent" time={time} />
          <Markdown text={ct.text} />
        </View>
      );
    case "thinking":
      return <Thinking text={ct.text} />;
    case "status":
      if (ct.permission) return <PermissionRow log={ct.permission} time={time} />;
      return (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 }}>
          <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
          <Text style={{ color: c.text3, fontSize: 12, flexShrink: 1, textAlign: "center" }}>
            {ct.text} · {time}
          </Text>
          <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: c.border }} />
        </View>
      );
    case "error":
      return (
        <View style={{ flexDirection: "row", gap: 8, padding: 10, borderRadius: 8, backgroundColor: c.redSoft }}>
          <Icon name="alert" size={14} color={c.red} strokeWidth={2} />
          <Text selectable style={{ color: c.red, flex: 1, fontSize: 14 }}>
            {ct.text}
          </Text>
        </View>
      );
    case "tool_result":
      return <ToolRow call={null} result={entry as ToolResultEntry} />;
    case "tool_call":
      return null;
  }
});

function Thinking({ text }: { text: string }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  return (
    <Pressable onPress={() => setOpen(!open)} style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} color={c.text3} />
        <Text style={{ color: c.text3, fontSize: 13, fontStyle: "italic" }}>Thinking</Text>
        {!open && (
          <Text style={{ color: c.text3, fontSize: 13, flex: 1 }} numberOfLines={1}>
            {text}
          </Text>
        )}
      </View>
      {open && (
        <Text selectable style={{ color: c.text2, fontSize: 13.5, lineHeight: 19, paddingLeft: 17 }}>
          {text}
        </Text>
      )}
    </Pressable>
  );
}

export function PermissionRow({ log, time }: { log: PermissionDecisionLog; time?: string }) {
  const c = useColors();
  const color = log.decision === "allow" ? c.green : log.decision === "ask" ? c.amber : c.red;
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", padding: 9, borderRadius: 8, borderLeftWidth: 2, borderLeftColor: color, backgroundColor: c.bgSunken }} accessibilityLabel={`${permissionVerb(log)}: ${log.summary}`}>
      <Icon name="shield" size={12} color={color} strokeWidth={2} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, color: c.text }}>
          <Text style={{ fontWeight: "600", color }}>{permissionVerb(log)}</Text> <Text style={{ fontFamily: MONO, fontSize: 12.5 }}>{log.summary}</Text>
        </Text>
        {!!log.reason && <Text style={{ fontSize: 12.5, color: c.text2 }}>{log.reason}</Text>}
        <Text style={{ fontSize: 11.5, color: c.text3 }}>
          {decisionSource(log)} · {log.mode} mode{time ? ` · ${time}` : ""}
        </Text>
      </View>
    </View>
  );
}

const ToolRow = memo(function ToolRow({ call, result }: { call: ToolCallEntry | null; result?: ToolResultEntry }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const name = shortToolName(call?.content.name ?? result?.content.name ?? "tool");
  const preview = call ? toolPreview(name, call.content.input) : "";
  const isError = result?.content.isError;
  return (
    <View style={{ borderRadius: RADIUS.md, borderWidth: StyleSheet.hairlineWidth, borderColor: isError ? c.red : c.border, backgroundColor: c.bgElev, overflow: "hidden" }}>
      <Pressable onPress={() => setOpen(!open)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 10, paddingVertical: 9 }}>
        <Icon name={open ? "chevronDown" : "chevronRight"} size={12} color={c.text3} />
        <Icon name={toolIcon(name)} size={13} color={c.text2} />
        <Text style={{ fontFamily: MONO, fontSize: 13, color: c.text, fontWeight: "600" }}>{name}</Text>
        <Text style={{ fontFamily: MONO, fontSize: 12.5, color: c.text3, flex: 1 }} numberOfLines={1}>
          {preview}
        </Text>
        {!result ? <Spinner /> : isError ? <Icon name="x" size={13} color={c.red} strokeWidth={2.5} /> : <Icon name="check" size={13} color={c.green} strokeWidth={2.5} />}
      </Pressable>
      {open && (
        <View style={{ paddingHorizontal: 10, paddingBottom: 10, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border, paddingTop: 8 }}>
          {call && (
            <>
              <Label>Input</Label>
              <Code text={JSON.stringify(call.content.input, null, 2)} />
            </>
          )}
          {result && (
            <>
              <Label>{isError ? "Error" : "Output"}</Label>
              <ToolOutput output={result.content.output} />
            </>
          )}
          {!result && <Text style={{ color: c.text3 }}>Running…</Text>}
        </View>
      )}
    </View>
  );
});

function Label({ children }: { children: string }) {
  const c = useColors();
  return <Text style={{ color: c.text3, fontSize: 11.5, fontWeight: "600", textTransform: "uppercase" }}>{children}</Text>;
}

function Code({ text }: { text: string }) {
  const c = useColors();
  return (
    <ScrollView horizontal style={{ backgroundColor: c.bgSunken, borderRadius: 6, maxHeight: 320 }} contentContainerStyle={{ padding: 8 }} nestedScrollEnabled>
      <Text selectable style={{ fontFamily: MONO, fontSize: 12, lineHeight: 17, color: c.text }}>
        {text}
      </Text>
    </ScrollView>
  );
}

function ToolOutput({ output }: { output: ToolResultContent[] }) {
  const c = useColors();
  if (!output.length) return <Text style={{ color: c.text3 }}>(no output)</Text>;
  return (
    <>
      {output.map((o, i) =>
        o.type === "text" ? <Code key={i} text={formatMaybeJson(o.text, 12000)} /> : <Image key={i} source={{ uri: `data:${o.mimeType};base64,${o.data}` }} style={{ width: "100%", aspectRatio: 16 / 10, borderRadius: 6 }} resizeMode="contain" accessibilityLabel="Tool output image" />,
      )}
    </>
  );
}
