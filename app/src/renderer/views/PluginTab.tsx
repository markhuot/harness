// Plugin tabs on a ticket: which tabs apply (GET /tickets/:key/tabs) and the iframe host.
import { useEffect, useMemo, useRef, useState } from "react";
import type { PluginTab, Ticket } from "@harness/shared";
import { useStore } from "../state/store";
import { createPluginHostBridge, currentTheme, pluginUiUrl } from "../state/pluginBridge";
import "./plugin.css";

/** Plugin tabs for this ticket; null while loading. Refetched when the workdir/branch changes or on reconnect. */
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
      .catch(() => !cancelled && setTabs([])); // an older service without plugins: no tabs
    return () => {
      cancelled = true;
    };
  }, [client, key, ticket?.workdir, ticket?.branch, epoch]);
  return tabs;
}

export function PluginFrame({ ticket, tab }: { ticket: Ticket; tab: PluginTab }) {
  const { client, navigate, route } = useStore();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const src = pluginUiUrl(client.baseUrl, tab.pluginId, tab.id);

  const routeRef = useRef(route);
  routeRef.current = route;
  const bridge = useMemo(
    () =>
      createPluginHostBridge({
        baseUrl: client.baseUrl,
        token: client.token,
        ticketKey: ticket.key,
        tabId: tab.id,
        frame: () => frameRef.current?.contentWindow ?? null,
        theme: () => currentTheme(),
        onReady: () => setReady(true),
        onOpenExternal: (url) => void window.harness?.openExternal(url),
        onNavigate: (key) => {
          const r = routeRef.current;
          navigate({ view: "board", projectId: r.view === "board" ? r.projectId : null, ticketKey: key, tab: "summaries" });
        },
      }),
    [client, ticket.key, tab.id, navigate],
  );

  useEffect(() => {
    const on = (e: MessageEvent) => void bridge.onMessage(e);
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [bridge]);

  // Theme contract: <html data-theme> always holds the resolved theme.
  useEffect(() => {
    let last = currentTheme();
    const mo = new MutationObserver(() => {
      const t = currentTheme();
      if (t !== last) bridge.sendTheme((last = t));
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, [bridge]);

  // Live updates: every ticket.upserted for this ticket gives a new object in the store.
  useEffect(() => {
    bridge.sendTicket(ticket);
  }, [bridge, ticket]);

  return (
    <div className="plugin-host">
      {!ready && (
        <div className="plugin-loading">
          <div className="spinner" />
        </div>
      )}
      <iframe
        key={`${ticket.key}/${tab.pluginId}/${tab.id}`}
        ref={frameRef}
        className={`plugin-frame ${ready ? "ready" : ""}`}
        title={`${tab.title} (${tab.pluginId})`}
        src={src}
        // Same-origin with the service so the plugin's API calls need no CORS; no top navigation, no popups.
        sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
        onLoad={() => {
          bridge.onLoad();
          // Plugins that skip the SDK never say ready; show them anyway.
          setTimeout(() => setReady(true), 1500);
        }}
      />
    </div>
  );
}
