// Plugin tabs: which apply to a ticket (GET /tickets/:key/tabs) and the WebView host. The page is
// the plugin's UI served by the service; the bridge rules are the desktop's (shared
// createPluginHostBridge), carried over the WebView transport in lib/pluginHost.

import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { WebView, type WebViewNavigation } from "react-native-webview";
import { useRouter } from "expo-router";
import type { PluginTab, Ticket } from "@harness/shared";
import { createPluginHostBridge, pluginUiUrl } from "@harness/shared/state";
import { createWebViewFrame, webViewMessageEvent } from "../lib/pluginHost";
import { pluginThemeInfo } from "@harness/shared/themes";
import { useColors, useTheme } from "../state/app";
import { useStore } from "../state/store";
import { Spinner } from "../ui/kit";

export function usePluginTabs(ticket: Ticket | undefined): PluginTab[] | null {
  const { client, epoch } = useStore();
  const [tabs, setTabs] = useState<PluginTab[] | null>(null);
  const key = ticket?.key;
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    client
      .ticketTabs(key)
      .then((t) => !cancelled && setTabs(t))
      .catch(() => !cancelled && setTabs([]));
    return () => {
      cancelled = true;
    };
  }, [client, key, ticket?.workdir, ticket?.branch, epoch]);
  return tabs;
}

export function PluginFrame({ ticket, tab }: { ticket: Ticket; tab: PluginTab }) {
  const { client } = useStore();
  const theme = useTheme();
  const c = useColors();
  const router = useRouter();
  const web = useRef<WebView>(null);
  const [ready, setReady] = useState(false);
  const src = pluginUiUrl(client.baseUrl, tab.pluginId, tab.id);
  // Plugins get the full theme (id, tokens, syntax theme) next to the old light/dark value.
  const themeInfo = useMemo(() => pluginThemeInfo(theme.theme), [theme.theme]);
  const themeRef = useRef(themeInfo);
  themeRef.current = themeInfo;

  const frame = useMemo(() => createWebViewFrame((script) => web.current?.injectJavaScript(script)), []);
  const bridge = useMemo(
    () =>
      createPluginHostBridge({
        baseUrl: client.baseUrl,
        token: client.token,
        ticketKey: ticket.key,
        tabId: tab.id,
        frame: () => frame,
        theme: () => themeRef.current,
        onReady: () => setReady(true),
        onOpenExternal: (url) => void Linking.openURL(url),
        onNavigate: (key) => router.push({ pathname: "/ticket/[key]", params: { key } }),
      }),
    [client, ticket.key, tab.id, frame, router],
  );
  const origin = bridge.serviceOrigin;

  useEffect(() => {
    bridge.sendTheme(themeInfo);
  }, [bridge, themeInfo]);
  useEffect(() => {
    bridge.sendTicket(ticket);
  }, [bridge, ticket]);

  // Only the service origin loads in the tab; anything else (a link) opens in Safari.
  const onShouldStart = (req: WebViewNavigation) => {
    if (req.url.startsWith(origin + "/") || req.url === origin || req.url === "about:blank") return true;
    if (/^(https?:|mailto:)/i.test(req.url)) void Linking.openURL(req.url);
    return false;
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <WebView
        ref={web}
        source={{ uri: src }}
        originWhitelist={[origin]}
        onShouldStartLoadWithRequest={onShouldStart}
        onMessage={(e) => {
          const ev = webViewMessageEvent(e.nativeEvent, frame);
          if (ev) bridge.onMessage(ev);
        }}
        onLoad={() => {
          bridge.onLoad();
          setTimeout(() => setReady(true), 1500);
        }}
        style={{ flex: 1, backgroundColor: c.bg, opacity: ready ? 1 : 0 }}
        containerStyle={{ backgroundColor: c.bg }}
        allowsBackForwardNavigationGestures={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        webviewDebuggingEnabled={__DEV__}
      />
      {!ready && (
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]}>
          <Spinner />
        </View>
      )}
    </View>
  );
}
