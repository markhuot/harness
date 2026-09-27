import { Stack } from "expo-router";
import { useColors } from "../../../src/state/app";

export default function TabStack() {
  const c = useColors();
  return <Stack screenOptions={{ contentStyle: { backgroundColor: c.bg }, headerTintColor: c.accent, headerTitleStyle: { color: c.text }, headerLargeTitleStyle: { color: c.text } }} />;
}
