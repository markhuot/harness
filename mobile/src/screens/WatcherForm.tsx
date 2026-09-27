// Create / edit a watcher (the desktop's WatcherForm).
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Watcher } from "@harness/shared";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Segmented } from "../ui/kit";
import { FormField, SSwitch, useInputStyle } from "../ui/settings";
import { PickerButton } from "../ui/selects";
import { pick } from "../ui/pick";
import { buttonItem, primaryItemStyle } from "../ui/header";

interface Draft {
  name: string;
  command: string;
  args: string;
  cwd: string;
  mode: Watcher["mode"];
  intervalSec: string;
  enabled: boolean;
  driver: string;
}

const toDraft = (w?: Watcher): Draft =>
  w
    ? { name: w.name, command: w.command, args: w.args.join("\n"), cwd: w.cwd ?? "", mode: w.mode, intervalSec: String(w.intervalSec), enabled: w.enabled, driver: w.driver ?? "" }
    : { name: "", command: "", args: "", cwd: "", mode: "loop", intervalSec: "300", enabled: true, driver: "" };

export function watcherBody(d: Draft): Partial<Watcher> & { name: string; command: string } {
  return {
    name: d.name.trim(),
    command: d.command.trim(),
    args: d.args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean),
    cwd: d.cwd.trim() || null,
    mode: d.mode,
    intervalSec: Math.max(1, Math.round(Number(d.intervalSec)) || 60),
    enabled: d.enabled,
    driver: d.driver || null,
  };
}

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
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));
  const valid = !!d.name.trim() && !!d.command.trim();
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    const ok = existing ? await act(() => client.updateWatcher(existing.id, watcherBody(d)), "Watcher saved") : await act(() => client.createWatcher(watcherBody(d)), "Watcher created");
    setBusy(false);
    if (ok) router.dismiss();
  };
  const chooseDriver = async () => {
    const v = await pick({ title: "Triage driver", selected: d.driver, choices: [{ value: "", label: "Default" }, ...state.drivers.map((x) => ({ value: x.id, label: x.name }))] });
    if (v !== undefined) set("driver", v);
  };
  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
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
        <FormField label="Command">
          <TextInput style={[input, { fontFamily: MONO, fontSize: 15 }]} value={d.command} placeholder="node" placeholderTextColor={c.text3} onChangeText={(v) => set("command", v)} autoCapitalize="none" autoCorrect={false} />
        </FormField>
        <FormField label="Arguments" hint="One argument per line. Executed without a shell; the command should print NDJSON work items.">
          <TextInput style={[input, { fontFamily: MONO, fontSize: 14, minHeight: 70, textAlignVertical: "top" }]} multiline value={d.args} placeholder="~/Sites/Jira/watch-jira.js" placeholderTextColor={c.text3} onChangeText={(v) => set("args", v)} autoCapitalize="none" autoCorrect={false} />
        </FormField>
        <FormField label="Working directory">
          <TextInput style={[input, { fontFamily: MONO, fontSize: 15 }]} value={d.cwd} placeholder="Optional" placeholderTextColor={c.text3} onChangeText={(v) => set("cwd", v)} autoCapitalize="none" autoCorrect={false} />
        </FormField>
        <FormField label="Triage driver">
          <View style={{ alignItems: "flex-start" }}>
            <PickerButton label={d.driver ? (state.drivers.find((x) => x.id === d.driver)?.name ?? d.driver) : "Default"} onPress={() => void chooseDriver()} />
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
          <SSwitch value={d.enabled} onChange={(v) => set("enabled", v)} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
