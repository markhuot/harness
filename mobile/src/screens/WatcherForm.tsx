// Create / edit a watcher (the desktop's WatcherForm).
import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Segmented } from "../ui/kit";
import { KeyboardAvoider } from "../ui/KeyboardAvoider";
import { FormField, SSwitch, useInputStyle } from "../ui/settings";
import { Select } from "../ui/selects";
import { driverOptions } from "../lib/selectOptions";
import { buttonItem, primaryItemStyle } from "../ui/header";
import { toDraft, watcherBody, type WatcherDraft as Draft } from "../lib/watcherDraft";

export function WatcherFormScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const input = useInputStyle();
  const existing = id ? state.watchers[String(id)] : undefined;
  const [d, setD] = useState<Draft>(() => toDraft(existing));
  const [busy, setBusy] = useState(false);
  const edited = useRef(false);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    edited.current = true;
    setD((p) => ({ ...p, [k]: v }));
  };
  // A cold start through a deep link renders before the snapshot has the watcher: fill the form
  // once it arrives, unless the user has already started typing.
  useEffect(() => {
    if (existing && !edited.current) setD(toDraft(existing));
  }, [existing?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const valid = !!d.name.trim() && !!d.command.trim();
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = existing ? await act(() => client.updateWatcher(existing.id, watcherBody(d)), "Watcher saved") : await act(() => client.createWatcher(watcherBody(d)), "Watcher created");
    setBusy(false);
    if (ok) router.dismiss();
  };
  return (
    <KeyboardAvoider style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: existing ? "Edit watcher" : "New watcher",
          unstable_headerLeftItems: () => [buttonItem("Cancel", "xmark", () => router.dismiss())],
          unstable_headerRightItems: () => [buttonItem(existing ? "Save" : "Create", "checkmark", () => void submit(), { ...primaryItemStyle(c), disabled: !valid || busy })],
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
        <FormField label="Name">
          <TextInput style={input} value={d.name} placeholder="jira" placeholderTextColor={c.text3} onChangeText={(v) => set("name", v)} autoCapitalize="none" autoFocus={!existing} />
        </FormField>
        <FormField label="Command" hint="Runs in your login shell, so pipes, PATH and loops like while true; do curl -s …; sleep 60; done work. Whatever it prints shows up in the Inbox.">
          <TextInput style={[input, { fontFamily: MONO, fontSize: 14, minHeight: 70, textAlignVertical: "top" }]} multiline value={d.command} placeholder="node ~/Sites/Jira/watch-jira.js" placeholderTextColor={c.text3} onChangeText={(v) => set("command", v)} autoCapitalize="none" autoCorrect={false} spellCheck={false} />
        </FormField>
        <FormField label="Prompt" hint="Optional. What triage should do with the output.">
          <TextInput style={[input, { minHeight: 70, textAlignVertical: "top" }]} multiline value={d.prompt} placeholder="If this event is assigned to me and has actionable next steps, dispatch it to an agent." placeholderTextColor={c.text3} onChangeText={(v) => set("prompt", v)} />
        </FormField>
        <FormField label="Working directory">
          <TextInput style={[input, { fontFamily: MONO, fontSize: 15 }]} value={d.cwd} placeholder="Optional" placeholderTextColor={c.text3} onChangeText={(v) => set("cwd", v)} autoCapitalize="none" autoCorrect={false} />
        </FormField>
        <FormField label="Triage driver">
          <View style={{ alignItems: "flex-start" }}>
            <Select value={d.driver} options={driverOptions(state.drivers, { none: "Default" })} onChange={(v) => set("driver", v)} placeholder={d.driver || "Default"} title="Triage driver" accessibilityName="Triage driver" />
          </View>
        </FormField>
        <FormField label="Mode" hint={d.mode === "loop" ? "Re-runs as soon as the command exits." : "Runs on a fixed schedule."}>
          <Segmented
            value={d.mode}
            onChange={(v) => set("mode", v)}
            options={[
              { value: "loop", label: "Loop" },
              { value: "interval", label: "Interval" },
            ]}
          />
          {d.mode === "interval" && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <TextInput style={[input, { width: 110 }]} keyboardType="number-pad" value={d.intervalSec} onChangeText={(v) => set("intervalSec", v)} />
              <Text style={{ color: c.text2 }}>seconds</Text>
            </View>
          )}
        </FormField>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
          <Text style={{ color: c.text, fontSize: 16 }}>Enabled</Text>
          <SSwitch label="Enabled" value={d.enabled} onChange={(v) => set("enabled", v)} />
        </View>
      </ScrollView>
    </KeyboardAvoider>
  );
}
