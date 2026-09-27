// Settings → Network: which addresses the service listens on, and pairing a phone (QR of the
// harness://pair link + token rotation). DESIGN.md "Network".

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ListenMode, ListenSetting, NetworkStatus, PairingInfo, PublicSettings } from "@harness/shared";
import { useStore } from "../../state/store";
import { encodeQr, qrPath } from "../../components/qr";
import { DraftInput, Row, Section } from "../Settings";
import "./network.css";

const MODES: { id: ListenMode; label: string; sub: string }[] = [
  { id: "localhost", label: "Localhost", sub: "Only this Mac (127.0.0.1)." },
  { id: "tailscale", label: "Tailscale", sub: "Your tailnet's devices, via this Mac's Tailscale address. Recommended for a phone." },
  { id: "any", label: "Any (0.0.0.0)", sub: "Every network this Mac is on, including shared Wi-Fi." },
  { id: "custom", label: "Custom", sub: "One address of this Mac (a hostname or IP), plus 127.0.0.1." },
];

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NetworkSection({ settings }: { settings: PublicSettings }) {
  const { client, onEvent } = useStore();
  const listen: ListenSetting = settings.listen ?? { mode: "localhost" };
  const [net, setNet] = useState<NetworkStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Picking Custom only shows the field; nothing is applied until a host is entered.
  const [customDraft, setCustomDraft] = useState(false);

  const load = useCallback(async () => {
    try {
      setNet(await client.network());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 10_000);
    const off = onEvent((e) => {
      if (e.kind === "settings.updated") void load();
    });
    return () => {
      clearInterval(timer);
      off();
    };
  }, [load, onEvent]);

  const apply = async (next: ListenSetting) => {
    setSaving(true);
    setApplyError(null);
    try {
      await client.updateSettings({ listen: next });
      setCustomDraft(false);
    } catch (e) {
      setApplyError(errorText(e));
    } finally {
      setSaving(false);
      void load();
    }
  };

  const pick = (mode: ListenMode) => {
    setApplyError(null);
    if (mode === "custom") {
      if (listen.mode === "custom") return;
      setCustomDraft(true);
      return;
    }
    setCustomDraft(false);
    if (mode !== listen.mode) void apply({ mode });
  };

  const shown: ListenMode = customDraft ? "custom" : listen.mode;
  const active = net?.active ?? listen.mode;
  const error = applyError ?? net?.error ?? loadError;

  return (
    <Section
      id="network"
      title="Network"
      desc="Where the service accepts connections. This Mac always reaches it on 127.0.0.1; every request from anywhere else needs the bearer token."
    >
      <div className="card-surface settings-card" data-testid="network-section">
        <Row title="Listen on" sub={MODES.find((m) => m.id === shown)!.sub}>
          <div className="segmented" role="radiogroup" aria-label="Listen on" data-testid="listen-mode">
            {MODES.map((m) => (
              <button
                key={m.id}
                role="radio"
                aria-checked={shown === m.id}
                className={shown === m.id ? "on" : ""}
                disabled={saving || !!net?.override}
                data-mode={m.id}
                onClick={() => pick(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        </Row>
        {shown === "custom" && (
          <Row title="Custom host" sub="A hostname or IP address that belongs to this Mac. Press Enter to apply.">
            <span data-testid="listen-custom-host">
              <DraftInput value={listen.host ?? ""} placeholder="192.168.1.20 or mac.local" onCommit={(h) => h.trim() && void apply({ mode: "custom", host: h.trim() })} />
            </span>
          </Row>
        )}
        {net?.override && (
          <Row title="Overridden" sub={`HARNESS_HOST=${net.override} is set for the service, so this setting can't be changed here.`} />
        )}
        {shown === "any" && (
          <div className="network-warning" data-testid="network-any-warning">
            Anyone on a network this Mac joins can reach the service. The token is the only lock, and it grants full control:
            running agents, reading your code, approving commands. Prefer Tailscale.
          </div>
        )}
        {error && (
          <div className="network-error settings-row-err" data-testid="network-error">
            {error}
          </div>
        )}
        <Row
          title="Listening"
          sub={
            <span className="network-list mono" data-testid="network-bound">
              {net ? net.bound.map((b) => <span key={b.url}>{b.url}</span>) : "…"}
              {net && active !== net.mode && <span className="muted">(fell back to localhost; retrying {net.mode})</span>}
            </span>
          }
        />
        <Row
          title="Tailscale"
          sub={
            <span className="network-list mono" data-testid="network-tailscale">
              {!net ? "…" : net.tailscale ? (
                <>
                  <span>{net.tailscale.ip}</span>
                  {net.tailscale.dnsName && <span>{net.tailscale.dnsName.replace(/\.$/, "")}</span>}
                </>
              ) : (
                <span className="muted">Not running on this Mac</span>
              )}
            </span>
          }
        />
      </div>

      <div className="settings-section-head" style={{ marginTop: 20 }}>
        <div className="section-title">Pair a phone</div>
      </div>
      <PairPhone active={active} bound={net?.bound.map((b) => b.url).join(" ") ?? ""} />
    </Section>
  );
}

function PairPhone({ active, bound }: { active: ListenMode; bound: string }) {
  const { client, reconnect, toast } = useStore();
  const [pairing, setPairing] = useState<PairingInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [rotating, setRotating] = useState(false);
  const enabled = active !== "localhost";

  useEffect(() => {
    if (!enabled) {
      setPairing(null);
      return;
    }
    let live = true;
    client.pairing().then(
      (p) => live && (setPairing(p), setError(null)),
      (e) => live && (setPairing(null), setError(errorText(e))),
    );
    return () => {
      live = false;
    };
  }, [client, enabled, bound]);

  const qr = useMemo(() => {
    if (!pairing) return null;
    const m = encodeQr(pairing.pairUrl);
    return { size: m.length + 8, d: qrPath(m, 4) };
  }, [pairing]);

  const copy = (text: string, what: string) => void navigator.clipboard.writeText(text).then(() => toast(`${what} copied`, "info"), (e) => toast(errorText(e)));

  const rotate = async () => {
    if (!confirm("Rotate the token?\n\nEvery paired phone and anything else using the current token is disconnected and must pair again.")) return;
    setRotating(true);
    try {
      const { token } = await client.rotateToken();
      await reconnect(token);
      toast("Token rotated. Pair your phone again.", "info");
    } catch (e) {
      toast(`Couldn't rotate the token: ${errorText(e)}`);
    } finally {
      setRotating(false);
    }
  };

  if (!enabled)
    return (
      <div className="card-surface settings-card pair-card disabled" data-testid="pair-disabled">
        <Row
          title="Not reachable from a phone"
          sub="The service only listens on this Mac. Choose Tailscale (recommended), Any or Custom above, then scan the code from the Harness phone app."
        />
      </div>
    );

  return (
    <div className="card-surface settings-card pair-card" data-testid="pair-card">
      <div className="pair-body">
        <div className="pair-qr" data-testid="pair-qr">
          {qr ? (
            <svg viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
              <rect width={qr.size} height={qr.size} fill="#fff" />
              <path d={qr.d} fill="#000" />
            </svg>
          ) : (
            <div className="pair-qr-empty">{error ? "—" : <div className="spinner" />}</div>
          )}
        </div>
        <div className="pair-info">
          <div className="dim">Scan with the Harness phone app. The code carries the address and the token.</div>
          {error && (
            <div className="settings-row-err" data-testid="pair-error">
              {error}
            </div>
          )}
          {pairing && (
            <>
              <div className="pair-field">
                <span className="pair-label">URL</span>
                <code className="selectable" data-testid="pair-url">
                  {pairing.url}
                </code>
                <button className="btn btn-sm" onClick={() => copy(pairing.url, "URL")}>
                  Copy
                </button>
              </div>
              <div className="pair-field">
                <span className="pair-label">Token</span>
                <code className="selectable" data-testid="pair-token">
                  {reveal ? pairing.token : "•".repeat(12) + pairing.token.slice(-4)}
                </code>
                <button className="btn btn-sm" data-testid="pair-token-reveal" onClick={() => setReveal((r) => !r)}>
                  {reveal ? "Hide" : "Show"}
                </button>
                <button className="btn btn-sm" onClick={() => copy(pairing.token, "Token")}>
                  Copy
                </button>
              </div>
            </>
          )}
          <div className="pair-actions">
            <button className="btn btn-sm btn-danger" data-testid="rotate-token" disabled={rotating} onClick={() => void rotate()}>
              {rotating ? "Rotating…" : "Rotate token"}
            </button>
            <span className="muted">Disconnects every paired device.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
