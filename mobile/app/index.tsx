import { Redirect } from "expo-router";
import { useApp } from "../src/state/app";

export default function Index() {
  const { loaded, active } = useApp();
  if (!loaded) return null;
  return <Redirect href={active ? "/board" : "/connect"} />;
}
