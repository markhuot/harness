// Pairing: scan the desktop's QR code (or let the Camera app open harness://pair…), or enter the
// URL and token by hand. Saved Macs can be switched between.
import { useState } from "react";
import { KeyboardAvoidingView, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useApp, useColors } from "../state/app";
import { useMaybeStore } from "../state/store";
import { checkToken, displayHost, normalizeBaseUrl, pairParams } from "../lib/pair";
import { MONO } from "../theme/tokens";
import { Button, Callout, Spinner } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { Group, SRow, useInputStyle } from "../ui/settings";
import { haptic } from "../ui/haptics";
import { useEffect } from "react";

export function ConnectScreen() {
  const { servers, active, activate, pair } = useApp();
  const store = useMaybeStore();
  const c = useColors();
  const router = useRouter();
  const input = useInputStyle();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const done = () => {
    haptic("success");
    if (router.canDismiss()) router.dismissAll();
    router.replace("/board");
  };
  const connect = async () => {
    setError(null);
    const base = normalizeBaseUrl(url);
    if (!base.ok) return setError(base.error);
    const tok = checkToken(token);
    if (!tok.ok) return setError(tok.error);
    setBusy(true);
    const r = await pair({ baseUrl: base.value, token: tok.value });
    setBusy(false);
    if (!r.ok) {
      haptic("error");
      return setError(r.message);
    }
    done();
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: "Connect to a Mac", headerShown: true }} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 22 }} keyboardShouldPersistTaps="handled">
        <View style={{ alignItems: "center", gap: 10, paddingTop: 8 }}>
          <View style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: c.accentSoft, alignItems: "center", justifyContent: "center" }}>
            <Icon name="layers" size={30} color={c.accent} strokeWidth={1.75} />
          </View>
          <Text style={{ color: c.text, fontSize: 22, fontWeight: "700", textAlign: "center" }}>Pair with Harness on your Mac</Text>
          <Text style={{ color: c.text2, fontSize: 15, textAlign: "center", lineHeight: 21 }}>On the Mac, open Harness → Settings → Network, choose Tailscale or All networks, and scan the QR code.</Text>
        </View>
        {store?.authError && <Callout tone="red" icon="key" title="Token rejected">{store.authError}</Callout>}
        <Button title="Scan QR code" icon="eye" variant="primary" onPress={() => router.push("/scan")} />
        {servers.length > 0 && (
          <Group title="Saved Macs">
            {servers.map((s, i) => (
              <SRow
                key={s.id}
                last={i === servers.length - 1}
                title={s.name}
                sub={<Text style={{ color: c.text3, fontFamily: MONO, fontSize: 12.5 }}>{displayHost(s.baseUrl)}</Text>}
                onPress={async () => {
                  await activate(s.id);
                  done();
                }}
              >
                {active?.id === s.id ? <Icon name="check" size={16} color={c.accent} strokeWidth={2.5} /> : undefined}
              </SRow>
            ))}
          </Group>
        )}
        <Group title="Enter manually" footer="The token is stored in the iPhone's Keychain.">
          <SRow title="Service URL" stacked>
            <TextInput style={[input, { fontFamily: MONO, fontSize: 15 }]} value={url} onChangeText={setUrl} placeholder="http://100.64.0.2:7717" placeholderTextColor={c.text3} autoCapitalize="none" autoCorrect={false} keyboardType="url" textContentType="URL" accessibilityLabel="Service URL" />
          </SRow>
          <SRow title="Token" stacked last>
            <TextInput style={[input, { fontFamily: MONO, fontSize: 14 }]} value={token} onChangeText={setToken} placeholder="From Settings → Network → Show token" placeholderTextColor={c.text3} autoCapitalize="none" autoCorrect={false} secureTextEntry accessibilityLabel="Token" onSubmitEditing={() => void connect()} />
          </SRow>
        </Group>
        {error && <Callout tone="red" icon="wifiOff">{error}</Callout>}
        <Button title="Connect" variant="secondary" onPress={() => void connect()} loading={busy} disabled={!url.trim() || !token.trim()} hapticKind={null} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** harness://pair?url=…&token=… (from the Camera app or a link). */
export function PairScreen() {
  const params = useLocalSearchParams<{ url?: string; token?: string }>();
  const { pair } = useApp();
  const c = useColors();
  const router = useRouter();
  const [status, setStatus] = useState<{ busy: boolean; error: string | null; host: string }>({ busy: true, error: null, host: "" });
  const run = async () => {
    const parsed = pairParams(params);
    if (!parsed.ok) return setStatus({ busy: false, error: parsed.error, host: "" });
    setStatus({ busy: true, error: null, host: displayHost(parsed.value.baseUrl) });
    const r = await pair(parsed.value);
    if (!r.ok) {
      haptic("error");
      return setStatus({ busy: false, error: r.message, host: displayHost(parsed.value.baseUrl) });
    }
    haptic("success");
    if (router.canDismiss()) router.dismissAll();
    router.replace("/board");
  };
  useEffect(() => {
    void run();
  }, [params.url, params.token]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ flex: 1, backgroundColor: c.bg, padding: 24, justifyContent: "center", gap: 16 }}>
      <Stack.Screen options={{ title: "Pairing" }} />
      {status.busy ? (
        <View style={{ alignItems: "center", gap: 12 }}>
          <Spinner size="large" />
          <Text style={{ color: c.text2, fontSize: 16 }}>Connecting to {status.host || "your Mac"}…</Text>
        </View>
      ) : (
        <>
          <Callout tone="red" icon="wifiOff" title="Couldn't pair">
            {status.error ?? ""}
          </Callout>
          <Button title="Try again" variant="primary" onPress={() => void run()} />
          <Pressable onPress={() => router.replace("/connect")}>
            <Text style={{ color: c.accent, textAlign: "center", fontSize: 15 }}>Enter the details manually</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}
