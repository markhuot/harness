// Settings → Prompts: the built-in agent prompts (GET /prompts), each either built-in (follows
// app updates) or customized (settings.prompts). The list, and one prompt's detail with its editor.
// DESIGN.md "Prompt overrides"; the logic is shared with the Mac (shared/src/prompts.ts).
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  brokenOverrideMessage,
  groupPrompts,
  insertText,
  lineDiff,
  PROMPT_STATE_LABELS,
  promptDraftDirty,
  promptDraftError,
  promptErrorLine,
  promptSavePatch,
  promptsLoadError,
  promptStartText,
  promptState,
  type PromptEntry,
} from "@harness/shared";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO, RADIUS } from "../theme/tokens";
import { Badge, Button, Callout, Empty, Segmented, Spinner, toneColors } from "../ui/kit";
import { KeyboardAvoider } from "../ui/KeyboardAvoider";
import { Group, SRow } from "../ui/settings";
import { buttonItem, primaryItemStyle } from "../ui/header";
import { confirm } from "../ui/pick";

export const PROMPTS_INTRO = "The instructions Harness gives agents. A built-in prompt picks up improvements with each app update; a customized one stays as you wrote it until you reset it.";

/** The prompt catalog, reloaded on reconnect and whenever settings change (on any client). */
export function usePrompts() {
  const { client, onEvent, epoch } = useStore();
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setPrompts(await client.listPrompts());
      setError(null);
    } catch (e) {
      setError(promptsLoadError(e));
    }
  }, [client]);
  useEffect(() => {
    void load();
    return onEvent((e) => {
      if (e.kind === "settings.updated") void load();
    });
  }, [load, onEvent, epoch]);
  return { prompts, error, load };
}

export function PromptBadge({ entry }: { entry: PromptEntry }) {
  const state = promptState(entry);
  if (state === "broken")
    return (
      <Badge tone="red" icon="alert">
        {PROMPT_STATE_LABELS.broken}
      </Badge>
    );
  return <Badge tone={state === "customized" ? "accent" : "neutral"}>{PROMPT_STATE_LABELS[state]}</Badge>;
}

function Loading({ error }: { error: string | null }) {
  const c = useColors();
  return <View style={{ flex: 1, backgroundColor: c.bg }}>{error ? <Empty icon="alert" title="Couldn't load prompts">{error}</Empty> : <View style={{ padding: 40, alignItems: "center" }}><Spinner /></View>}</View>;
}

// ---------------------------------------------------------------------------

export function PromptsScreen() {
  const { prompts, error } = usePrompts();
  const c = useColors();
  const router = useRouter();
  if (!prompts) return <Loading error={error} />;
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 60 }}>
      <Stack.Screen options={{ title: "Prompts" }} />
      <Text style={{ color: c.text3, fontSize: 13, lineHeight: 18, paddingHorizontal: 16 }}>{PROMPTS_INTRO}</Text>
      {groupPrompts(prompts).map((g) => (
        <Group key={g.group} title={g.title} footer={g.description}>
          {g.entries.map((p, i) => (
            <SRow
              key={p.id}
              chevron
              last={i === g.entries.length - 1}
              onPress={() => router.push({ pathname: "/prompt/[id]", params: { id: p.id } })}
              title={
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <Text style={{ color: c.text, fontSize: 16 }}>{p.label}</Text>
                  <PromptBadge entry={p} />
                </View>
              }
              sub={p.description}
            />
          ))}
        </Group>
      ))}
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

export function PromptDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { prompts, error, load } = usePrompts();
  const c = useColors();
  if (!prompts) return <Loading error={error} />;
  const entry = prompts.find((p) => p.id === String(id));
  if (!entry)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Empty icon="fileText" title="This prompt doesn't exist in this version of Harness" />
      </View>
    );
  return <PromptDetail key={entry.id} entry={entry} reload={load} />;
}

function PromptDetail({ entry, reload }: { entry: PromptEntry; reload: () => Promise<void> }) {
  const { client, toast } = useStore();
  const c = useColors();
  // null: showing the built-in read-only; a string: the text being edited.
  const [draft, setDraft] = useState<string | null>(entry.override);
  const [compare, setCompare] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const selection = useRef({ start: 0, end: 0 });
  const input = useRef<TextInput>(null);

  const editing = draft !== null;
  const dirty = editing && promptDraftDirty(entry, draft);
  const liveError = editing ? promptDraftError(entry, draft) : null;
  const errorLine = promptErrorLine(entry, draft, serverError);
  const state = promptState(entry);

  // Another client saved or reset this prompt: follow it unless there are edits to keep.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (!dirtyRef.current) setDraft(entry.override);
  }, [entry.override]);

  const change = (text: string) => {
    setDraft(text);
    setServerError(null);
  };

  const save = async (value: string | null, message: string) => {
    setSaving(true);
    setServerError(null);
    try {
      const patch = promptSavePatch(entry, value);
      await client.updateSettings(patch);
      if (patch.prompts![entry.id] == null) setDraft(null);
      dirtyRef.current = false;
      toast(message, "info");
      await reload();
    } catch (e) {
      // Keep the text: the service's 400 says what to fix.
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const canSave = editing && dirty && !liveError && !saving;
  const submit = () => {
    if (!canSave) return;
    const resets = promptSavePatch(entry, draft).prompts![entry.id] == null;
    void save(draft, resets ? "Prompt reset to built-in" : "Prompt saved");
  };
  const cancel = () => {
    setServerError(null);
    setCompare(false);
    setDraft(entry.override);
    input.current?.blur();
  };
  const reset = async () => {
    if (await confirm(`Reset “${entry.label}” to the built-in prompt?`, "Your text is discarded, and the prompt follows app updates again.", "Reset")) void save(null, "Prompt reset to built-in");
  };
  const insertVar = (name: string) => {
    if (draft === null) return;
    const { start, end } = selection.current;
    const next = insertText(draft, start, end, `{{${name}}}`);
    change(next.text);
    selection.current = { start: next.caret, end: next.caret };
  };

  // Cancel stands in for Back while there's something to cancel, so edits aren't lost to a swipe.
  const cancellable = dirty || (editing && entry.override === null);
  const mono = { fontFamily: MONO, fontSize: 13, lineHeight: 19, color: c.text };

  return (
    <KeyboardAvoider style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: entry.label,
          gestureEnabled: !cancellable,
          headerBackVisible: !cancellable,
          unstable_headerLeftItems: cancellable ? () => [buttonItem("Cancel", "xmark", cancel)] : undefined,
          unstable_headerRightItems: editing ? () => [buttonItem("Save", "checkmark", submit, { ...primaryItemStyle(c), disabled: !canSave })] : undefined,
        }}
      />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 40 }} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive">
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <PromptBadge entry={entry} />
            {saving && <Spinner />}
          </View>
          <Text style={{ color: c.text2, fontSize: 14, lineHeight: 20 }}>{entry.description}</Text>
        </View>

        {state === "broken" && (
          <Callout tone="red" icon="alert" title={PROMPT_STATE_LABELS.broken}>
            {brokenOverrideMessage(entry)}
          </Callout>
        )}

        {/* Above the text: a built-in prompt can run to a few screens. */}
        {(!editing || entry.override !== null) && (
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {!editing && <Button title="Customize" icon="edit" variant="primary" onPress={() => change(promptStartText(entry))} />}
            {entry.override !== null && <Button title="Reset to built-in" icon="refresh" variant="danger" disabled={saving} onPress={() => void reset()} />}
          </View>
        )}

        {editing && (
          <Segmented
            value={compare ? "compare" : "edit"}
            onChange={(v) => {
              setCompare(v === "compare");
              input.current?.blur();
            }}
            options={[
              { value: "edit", label: "Edit" },
              { value: "compare", label: "Compare with built-in" },
            ]}
          />
        )}

        {!editing ? (
          <View style={[styles.text, { backgroundColor: c.bgElev, borderColor: c.border }]}>
            <Text style={{ color: c.text3, fontSize: 12, fontWeight: "600", marginBottom: 8 }}>BUILT-IN TEXT · READ-ONLY</Text>
            <Text style={mono} selectable accessibilityLabel={`${entry.label} prompt`}>
              {entry.builtin}
            </Text>
          </View>
        ) : compare ? (
          <PromptDiff from={entry.builtin} to={draft} />
        ) : (
          <TextInput
            ref={input}
            style={[styles.text, mono, { backgroundColor: c.bgElev, borderColor: errorLine ? c.red : c.border, textAlignVertical: "top" }]}
            multiline
            scrollEnabled={false}
            value={draft}
            onChangeText={change}
            onSelectionChange={(e) => (selection.current = e.nativeEvent.selection)}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            accessibilityLabel={`${entry.label} prompt`}
          />
        )}

        {errorLine && (
          <Text style={{ color: c.red, fontSize: 13.5, lineHeight: 19 }} selectable>
            {errorLine}
          </Text>
        )}

        <Text style={{ color: c.text3, fontSize: 13, lineHeight: 18 }}>
          {editing
            ? "A customized prompt doesn't pick up built-in improvements from app updates. Reset it to follow the built-in again. Leaving it empty, or the same as the built-in, saves it as built-in."
            : "Built-in: this text improves with app updates while the prompt isn't customized."}
        </Text>

        {entry.variables.length > 0 && (
          <Group
            title="Variables"
            footer={
              <Text style={{ color: c.text3, fontSize: 13, paddingHorizontal: 16, lineHeight: 18 }}>
                <Text style={{ fontFamily: MONO, fontSize: 12 }}>{"{{#if name}} … {{else}} … {{/if}}"}</Text> includes text only when a variable is set (true or not empty).
                {editing && !compare ? " Tap a variable to insert it at the cursor." : ""}
              </Text>
            }
          >
            {entry.variables.map((v, i) => (
              <SRow
                key={v.name}
                last={i === entry.variables.length - 1}
                onPress={editing && !compare ? () => insertVar(v.name) : undefined}
                title={<Text style={{ fontFamily: MONO, fontSize: 14, color: editing && !compare ? c.accent : c.text }}>{`{{${v.name}}}`}</Text>}
                sub={v.description}
              />
            ))}
          </Group>
        )}
      </ScrollView>
    </KeyboardAvoider>
  );
}

function PromptDiff({ from, to }: { from: string; to: string }) {
  const c = useColors();
  const lines = lineDiff(from, to);
  const add = toneColors(c, "green");
  const del = toneColors(c, "red");
  return (
    <View style={[styles.text, { backgroundColor: c.bgElev, borderColor: c.border, paddingHorizontal: 0 }]}>
      {!lines.some((l) => l.type !== "same") && <Text style={{ color: c.text3, fontSize: 13, paddingHorizontal: 12, marginBottom: 6 }}>Same as the built-in.</Text>}
      {lines.map((l, i) => (
        <Text
          key={i}
          style={{ fontFamily: MONO, fontSize: 12, lineHeight: 18, paddingHorizontal: 12, color: l.type === "same" ? c.text2 : l.type === "add" ? add.fg : del.fg, backgroundColor: l.type === "same" ? "transparent" : l.type === "add" ? add.bg : del.bg }}
          selectable
        >
          {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}
          {l.text}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  text: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.lg, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, minHeight: 160 },
});
