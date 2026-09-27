// Routes that need a connection render only once the saved server has loaded from the Keychain
// (a cold start through a deep link lands here before that), and send you to pairing without one.
import type { ComponentType } from "react";
import { View } from "react-native";
import { Redirect } from "expo-router";
import { useApp, useColors } from "../state/app";
import { useMaybeStore } from "../state/store";
import { Spinner } from "../ui/kit";

export function requireStore<P extends object>(Screen: ComponentType<P>) {
  return function Guarded(props: P) {
    const { loaded, active } = useApp();
    const store = useMaybeStore();
    const c = useColors();
    if (loaded && !active) return <Redirect href="/connect" />;
    if (!loaded || !store)
      return (
        <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}>
          <Spinner />
        </View>
      );
    return <Screen {...props} />;
  };
}
