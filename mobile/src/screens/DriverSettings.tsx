// One driver's settings, opened from Settings → Drivers: its status and sign-in, the review model,
// and the Anthropic API key for anthropic-api.
import { useState } from "react";
import { Linking, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import type { DriverInfo, PublicSettings } from "@harness/shared";
import { modelCacheFor } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Badge, Button, Empty } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { Group, SRow, useInputStyle } from "../ui/settings";
import { ModelPicker } from "../ui/selects";

export function driverStatus(d: DriverInfo) {
  if (!d.available) return <Badge tone="red">Unavailable</Badge>;
  if (!d.authenticated) return <Badge tone="amber">Not signed in</Badge>;
  return (
    <Badge tone="green" icon="check">
      Ready
    </Badge>
  );
}

export function DriverSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state } = useStore();
  const c = useColors();
  const driver = state.drivers.find((d) => d.id === String(id));
  if (!driver)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Empty icon="bot" title="The service doesn't report this driver" />
      </View>
    );
  return <DriverSettings driver={driver} settings={state.settings} />;
}

function DriverSettings({ driver: d, settings }: { driver: DriverInfo; settings: PublicSettings | null }) {
  const { client, toast } = useStore();
  const act = useAction();
  const c = useColors();
  const login = async () => {
    const res = await act(() => client.loginDriver(d.id));
    if (!res) return;
    if (res.url) await WebBrowser.openBrowserAsync(res.url).catch(() => Linking.openURL(res.url!));
    if (res.message) toast(res.message, "info");
  };
  const isDefault = settings?.defaultDriver === d.id;
  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ title: d.name }} />
      <Group footer={d.description}>
        <SRow
          title="Status"
          sub={d.detail ?? undefined}
          last={!d.supportsLogin}
        >
          <View style={{ flexDirection: "row", gap: 6 }}>
            {driverStatus(d)}
            {isDefault && <Badge tone="accent">Default</Badge>}
          </View>
        </SRow>
        {d.supportsLogin && <SRow title={<Text style={{ color: c.accent, fontSize: 16 }}>{d.authenticated ? "Log in again" : "Log in"}</Text>} onPress={() => void login()} last />}
      </Group>
      {d.id === "anthropic-api" && settings && <AnthropicKeyGroup settings={settings} />}
      {settings && (
        <Group title="Models" footer="The model agent reviews run on for tickets on this driver. Same as work uses the ticket's own model.">
          <SRow title="Review model" last>
            <ModelPicker driver={d.id} value={settings.reviewModels[d.id] ?? null} defaultLabel="Same as work" plainDefault onChange={(m) => void act(() => client.updateSettings({ reviewModels: { [d.id]: m } }))} title="Review model" />
          </SRow>
        </Group>
      )}
    </ScrollView>
  );
}

function AnthropicKeyGroup({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  const c = useColors();
  const inputStyle = useInputStyle();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  // A new or cleared key changes which models this driver can list.
  const reloadModels = () => void modelCacheFor(client).load("anthropic-api", true);
  const saveKey = async () => {
    if (!apiKey.trim()) return;
    const ok = await act(() => client.updateSettings({ anthropicApiKey: apiKey.trim() }), "API key saved");
    if (ok) {
      setApiKey("");
      setReplacing(false);
      reloadModels();
    }
  };
  const clearKey = async () => {
    if (await act(() => client.updateSettings({ anthropicApiKey: null }), "API key cleared")) reloadModels();
  };
  return (
    <Group title="API key" footer="Stored by the service; falls back to ANTHROPIC_API_KEY.">
      <SRow title="Anthropic API key" stacked last>
        {settings.anthropicApiKeySet && !replacing ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="checkCircle" size={15} color={c.green} />
            <Text style={{ color: c.green, flex: 1, fontSize: 15 }}>Key saved</Text>
            <Button small title="Replace" onPress={() => setReplacing(true)} />
            <Button small title="Clear" variant="danger" onPress={() => void clearKey()} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput style={[inputStyle, { flex: 1, fontFamily: MONO, fontSize: 14 }]} secureTextEntry placeholder="sk-ant-…" placeholderTextColor={c.text3} value={apiKey} onChangeText={setApiKey} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void saveKey()} accessibilityLabel="Anthropic API key" />
            <Button title="Save" variant="primary" disabled={!apiKey.trim()} onPress={() => void saveKey()} />
            {replacing && <Button title="Cancel" variant="ghost" onPress={() => setReplacing(false)} />}
          </View>
        )}
      </SRow>
    </Group>
  );
}
