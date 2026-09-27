// Connection status (the desktop sidebar's "Connected / Reconnecting…" footer), shown only when
// something is wrong; a rejected token links to re-pairing.
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { displayHost } from "../lib/pair";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { Icon } from "../ui/Icon";
import { Spinner } from "../ui/kit";

export function ConnectionBanner() {
  const { state, authError, loadError, baseUrl, refresh } = useStore();
  const c = useColors();
  const router = useRouter();
  if (authError) {
    return (
      <Pressable onPress={() => router.push("/connect")} style={{ flexDirection: "row", gap: 8, alignItems: "center", padding: 10, marginHorizontal: 12, marginTop: 6, borderRadius: 10, backgroundColor: c.redSoft }}>
        <Icon name="key" size={14} color={c.red} strokeWidth={2} />
        <Text style={{ color: c.red, fontSize: 13.5, flex: 1 }}>Token changed on the Mac. Tap to pair again.</Text>
        <Icon name="chevronRight" size={13} color={c.red} />
      </Pressable>
    );
  }
  if (state.connected) return null;
  return (
    <Pressable onPress={() => void refresh()} style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 8, paddingHorizontal: 12, marginHorizontal: 12, marginTop: 6, borderRadius: 10, backgroundColor: c.amberSoft }}>
      {loadError ? <Icon name="wifiOff" size={14} color={c.amber} strokeWidth={2} /> : <Spinner color={c.amber} />}
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.amber, fontSize: 13.5, fontWeight: "600" }}>Reconnecting to {displayHost(baseUrl)}…</Text>
        {loadError && (
          <Text style={{ color: c.text2, fontSize: 12.5 }} numberOfLines={3}>
            {loadError}
          </Text>
        )}
      </View>
    </Pressable>
  );
}
