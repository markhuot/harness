// In-app QR scanner for the pairing code.
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useApp } from "../state/app";
import { parsePairLink } from "../lib/pair";
import { Button, Spinner } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { haptic } from "../ui/haptics";

export function ScanScreen() {
  const [permission, request] = useCameraPermissions();
  const { pair } = useApp();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const handled = useRef<string | null>(null);

  const onScan = async (data: string) => {
    if (busy || handled.current === data) return;
    handled.current = data;
    const parsed = parsePairLink(data);
    if (!parsed.ok) {
      haptic("warning");
      setMessage(parsed.error);
      return;
    }
    setBusy(true);
    setMessage(null);
    const r = await pair(parsed.value);
    setBusy(false);
    if (!r.ok) {
      haptic("error");
      setMessage(r.message);
      handled.current = null;
      return;
    }
    haptic("success");
    router.dismissAll();
    router.replace("/board");
  };

  return (
    <View style={{ flex: 1, backgroundColor: "#000" }}>
      {permission?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={(r) => void onScan(r.data)} />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 30, gap: 14 }}>
          <Text style={{ color: "#fff", fontSize: 17, textAlign: "center" }}>Harness needs the camera to scan the pairing QR code.</Text>
          {permission && <Button title={permission.canAskAgain ? "Allow camera" : "Open Settings to allow"} variant="primary" onPress={() => void request()} />}
        </View>
      )}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
        <View style={{ width: 240, height: 240, borderRadius: 28, borderWidth: 3, borderColor: "rgba(255,255,255,0.85)" }} />
      </View>
      <View style={{ position: "absolute", left: 0, right: 0, bottom: insets.bottom + 24, alignItems: "center", gap: 12, paddingHorizontal: 24 }}>
        {busy && <Spinner color="#fff" />}
        <Text style={{ color: "#fff", fontSize: 15, textAlign: "center", backgroundColor: "rgba(0,0,0,0.55)", padding: 10, borderRadius: 12, overflow: "hidden" }}>
          {message ?? "Point at the QR code in Harness → Settings → Network on your Mac."}
        </Text>
      </View>
      <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Close" style={{ position: "absolute", top: insets.top + 10, right: 16, width: 40, height: 40, borderRadius: 20, backgroundColor: "rgba(0,0,0,0.5)", alignItems: "center", justifyContent: "center" }}>
        <Icon name="x" size={20} color="#fff" strokeWidth={2.25} />
      </Pressable>
    </View>
  );
}
