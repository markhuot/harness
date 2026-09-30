import { useEffect } from "react";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { AppProvider, ThemeSync, useApp, useTheme } from "../src/state/app";
import { StoreProvider } from "../src/state/store";
import { ToastProvider, useToast } from "../src/ui/Toasts";

void SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  return (
    <AppProvider>
      <ThemeSync />
      <Themed />
    </AppProvider>
  );
}

function Themed() {
  const { c, resolved } = useTheme();
  const { loaded } = useApp();
  useEffect(() => {
    if (loaded) void SplashScreen.hideAsync().catch(() => {});
  }, [loaded]);
  const base = resolved === "dark" ? DarkTheme : DefaultTheme;
  const navTheme = { ...base, colors: { ...base.colors, primary: c.accent, background: c.bg, card: c.bgElev, text: c.text, border: c.border, notification: c.red } };
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style={resolved === "dark" ? "light" : "dark"} />
      <ToastProvider>
        <Connection>
          <Stack screenOptions={{ contentStyle: { backgroundColor: c.bg }, headerTintColor: c.accent, headerTitleStyle: { color: c.text }, headerBackButtonDisplayMode: "minimal" }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="ticket/[key]" options={{ title: "" }} />
            <Stack.Screen name="inbox/[id]" options={{ title: "" }} />
            <Stack.Screen name="file" options={{ title: "" }} />
            <Stack.Screen name="project/[id]" options={{ title: "Project settings" }} />
            <Stack.Screen name="prompts" options={{ title: "Prompts" }} />
            <Stack.Screen name="prompt/[id]" options={{ title: "" }} />
            <Stack.Screen name="new" options={{ presentation: "modal", title: "New session" }} />
            <Stack.Screen name="projects" options={{ presentation: "formSheet", title: "Projects", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true, headerShown: true }} />
            <Stack.Screen name="watcher" options={{ presentation: "modal", title: "Watcher" }} />
            <Stack.Screen name="connect" options={{ presentation: "modal", title: "Connect to a Mac" }} />
            <Stack.Screen name="scan" options={{ presentation: "fullScreenModal", headerShown: false }} />
            <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pairing" }} />
          </Stack>
        </Connection>
      </ToastProvider>
    </ThemeProvider>
  );
}

/** One live connection for the active server; rebuilt when the server or its token changes. */
function Connection({ children }: { children: React.ReactNode }) {
  const { active, connectionNonce } = useApp();
  const toast = useToast();
  if (!active) return <>{children}</>;
  return (
    <StoreProvider key={`${active.id}:${connectionNonce}`} baseUrl={active.baseUrl} token={active.token} toast={toast}>
      {children}
    </StoreProvider>
  );
}
