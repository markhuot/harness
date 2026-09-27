import { Redirect } from "expo-router";
import { NativeTabs } from "expo-router/unstable-native-tabs";
import { triageSessions } from "@harness/shared/state";
import { useApp, useColors } from "../../src/state/app";
import { useMaybeStore } from "../../src/state/store";

export default function TabsLayout() {
  const { loaded, active } = useApp();
  const store = useMaybeStore();
  const c = useColors();
  if (!loaded) return null;
  if (!active) return <Redirect href="/connect" />;
  const triaging = store ? triageSessions(store.state).filter((s) => s.triageStatus === "triaging" || s.busy).length : 0;
  return (
    <NativeTabs tintColor={c.accent} badgeBackgroundColor={c.redSolid}>
      <NativeTabs.Trigger name="board">
        <NativeTabs.Trigger.Icon sf={{ default: "rectangle.split.3x1", selected: "rectangle.split.3x1.fill" }} />
        <NativeTabs.Trigger.Label>Board</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: "tray", selected: "tray.fill" }} />
        <NativeTabs.Trigger.Label>Inbox</NativeTabs.Trigger.Label>
        {triaging > 0 && <NativeTabs.Trigger.Badge>{String(triaging)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings">
        <NativeTabs.Trigger.Icon sf={{ default: "gearshape", selected: "gearshape.fill" }} />
        <NativeTabs.Trigger.Label>Settings</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
