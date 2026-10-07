// Settings → Notifications: the switches for which card activity sends a system notification, the
// APNs signing keys the service pushes with, and the devices it pushes to. DESIGN.md "Notifications".

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_INFO,
  type ApnsKeyStatus,
  type Device,
  type NotificationSettingsPatch,
  type NotificationStatus,
  type PublicSettings,
  type TestNotificationResult,
} from "@harness/shared";
import { useAction, useStore } from "../../state/store";
import { relativeTime, Switch } from "../../components/bits";
import { Icon } from "../../components/Icon";
import { DraftInput, Row, Section } from "../Settings";
import "./notifications.css";

const DEFAULT_KEY_DIR = "~/.appstoreconnect/private_keys";
const ENV_LABEL = { sandbox: "Sandbox", production: "Production" } as const;
const ENV_FILE = { sandbox: "AuthKey_<id>_APN_Sandbox.p8", production: "AuthKey_<id>_APN_Production.p8" } as const;
const PLATFORM_LABEL = { mac: "Mac", ios: "iPhone/iPad" } as const;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function NotificationsSection({ settings }: { settings: PublicSettings }) {
  const { client, onEvent, epoch } = useStore();
  const act = useAction();
  const prefs = settings.notifications ?? DEFAULT_NOTIFICATION_SETTINGS;
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await client.notificationStatus());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
    return onEvent((e) => {
      if (e.kind === "devices.changed" || e.kind === "settings.updated") void load();
    });
  }, [load, onEvent, epoch]);

  const save = (notifications: NotificationSettingsPatch) => act(() => client.updateSettings({ notifications }));
  const categoryOn = (c: (typeof NOTIFICATION_CATEGORIES)[number]) => prefs.categories?.[c] !== false;

  return (
    <Section
      id="notifications"
      title="Notifications"
      desc="The service sends a system notification through Apple Push when an agent or the service writes to a card, unless that ticket is on screen in a Harness window. How each device shows them is up to its own notification settings."
    >
      <div className="card-surface settings-card" data-testid="notifications-section">
        <Row title="Send notifications" sub="Card activity from agents and the service. Nothing you write yourself notifies.">
          <Switch checked={prefs.enabled} ariaLabel="Send notifications" onChange={(v) => void save({ enabled: v })} />
        </Row>
        {NOTIFICATION_CATEGORIES.map((c) => (
          <Row key={c} title={NOTIFICATION_CATEGORY_INFO[c].label} sub={NOTIFICATION_CATEGORY_INFO[c].description}>
            <Switch
              checked={prefs.enabled && categoryOn(c)}
              disabled={!prefs.enabled}
              ariaLabel={NOTIFICATION_CATEGORY_INFO[c].label}
              onChange={(v) => void save({ categories: { [c]: v } })}
            />
          </Row>
        ))}
      </div>

      <div className="settings-section-head notif-subhead">
        <div className="section-title">Signing keys</div>
      </div>
      <div className="card-surface settings-card" data-testid="notifications-keys">
        <Row title="Key folder" sub={<>The service looks here for its APNs keys. Empty uses <span className="mono">{DEFAULT_KEY_DIR}</span>.</>}>
          <DraftInput className="input mono" value={prefs.apnsKeyDir ?? ""} placeholder={DEFAULT_KEY_DIR} onCommit={(v) => void save({ apnsKeyDir: v.trim() || null })} />
          {window.harness?.pickDirectory && (
            <button
              className="btn btn-sm"
              onClick={async () => {
                const dir = await window.harness!.pickDirectory({ title: "APNs key folder", buttonLabel: "Use folder", defaultPath: status?.keyDir });
                if (dir) void save({ apnsKeyDir: dir });
              }}
            >
              Choose…
            </button>
          )}
        </Row>
        <Row title="Team ID" sub="The Apple developer team that owns the keys.">
          <DraftInput className="input mono" value={prefs.apnsTeamId} placeholder={DEFAULT_NOTIFICATION_SETTINGS.apnsTeamId} onCommit={(v) => void save({ apnsTeamId: v.trim() || DEFAULT_NOTIFICATION_SETTINGS.apnsTeamId })} />
        </Row>
        {(["sandbox", "production"] as const).map((env) => (
          <KeyRow key={env} env={env} keyDir={status?.keyDir ?? null} status={status?.keys.find((k) => k.environment === env) ?? null} loading={!status && !loadError} />
        ))}
        {loadError && (
          <div className="notif-error settings-row-err" data-testid="notifications-error">
            Couldn't read the notification status: {loadError}
          </div>
        )}
      </div>

      <div className="settings-section-head notif-subhead">
        <div className="section-title">Devices</div>
        <TestButton disabled={!status?.devices.length} />
      </div>
      <Devices devices={status?.devices ?? null} />
    </Section>
  );
}

function KeyRow({ env, keyDir, status, loading }: { env: "sandbox" | "production"; keyDir: string | null; status: ApnsKeyStatus | null; loading: boolean }) {
  const found = !!status?.keyId;
  const last = status?.lastResult;
  return (
    <div className="settings-row" data-testid={`notifications-key-${env}`}>
      <div className="settings-row-main">
        <div className="settings-row-title">
          {ENV_LABEL[env]}
          {loading ? null : found ? (
            <span className="badge notif-ok">
              <Icon name="check" size={10} /> {status!.keyId}
            </span>
          ) : (
            <span className="badge badge-outline notif-missing">Missing</span>
          )}
        </div>
        <div className="settings-row-sub mono" title={status?.path ?? undefined}>
          {found ? status!.path : <>{ENV_FILE[env]} in {keyDir ?? "…"}</>}
        </div>
        <div className="settings-row-sub">
          {!last ? (
            "No push sent with it yet"
          ) : last.ok ? (
            <>Last push {relativeTime(last.at)}: accepted ({last.status})</>
          ) : (
            <span className="notif-failed">
              Last push {relativeTime(last.at)} failed: {last.status}
              {last.reason ? ` ${last.reason}` : ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function TestButton({ disabled }: { disabled: boolean }) {
  const { client, toast } = useStore();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TestNotificationResult | null>(null);
  const send = async () => {
    setSending(true);
    try {
      const r = await client.sendTestNotification();
      setResult(r);
      const failed = r.results.filter((x) => !x.ok).length;
      toast(`Test notification sent to ${r.sent} device${r.sent === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}`, failed ? "error" : "info");
    } catch (e) {
      toast(`Couldn't send a test notification: ${errorText(e)}`, "error");
    } finally {
      setSending(false);
    }
  };
  return (
    <>
      {result && (
        <span className="muted notif-test-result" data-testid="notifications-test-result">
          Sent to {result.sent} device{result.sent === 1 ? "" : "s"}
        </span>
      )}
      <button className="btn btn-sm" data-testid="notifications-test" disabled={disabled || sending} onClick={() => void send()}>
        {sending ? <span className="spinner" /> : <Icon name="send" size={11} />} Send test notification
      </button>
    </>
  );
}

function Devices({ devices }: { devices: Device[] | null }) {
  const { client } = useStore();
  const act = useAction();
  const [thisDevice, setThisDevice] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.harness?.deviceId?.().then((id) => live && setThisDevice(id), () => {});
    return () => {
      live = false;
    };
  }, []);

  if (!devices)
    return (
      <div className="card-surface empty">
        <div className="spinner" />
        Loading devices…
      </div>
    );
  if (!devices.length)
    return (
      <div className="card-surface empty" data-testid="notifications-no-devices">
        <Icon name="phone" />
        <strong>No devices yet</strong>
        The Mac and iPhone apps register themselves once they're signed for push and allowed to notify.
      </div>
    );
  const sorted = [...devices].sort((a, b) => b.lastSeen - a.lastSeen);
  return (
    <div className="card-surface settings-card" data-testid="notifications-devices">
      {sorted.map((d) => (
        <div className="settings-row" key={d.id} data-testid="notifications-device">
          <div className="settings-row-main">
            <div className="settings-row-title">
              {d.name}
              <span className="badge">{PLATFORM_LABEL[d.platform] ?? d.platform}</span>
              <span className="badge badge-outline">{ENV_LABEL[d.environment] ?? d.environment}</span>
              {d.id === thisDevice && <span className="muted">This Mac</span>}
            </div>
            <div className="settings-row-sub">
              Last seen {relativeTime(d.lastSeen)} · token <span className="mono">…{d.tokenSuffix}</span>
            </div>
          </div>
          <div className="settings-row-actions">
            <button
              className="btn btn-sm btn-ghost btn-icon btn-danger"
              title="Remove"
              aria-label={`Remove ${d.name}`}
              onClick={() => {
                if (confirm(`Stop sending notifications to “${d.name}”?\n\nThe app registers again the next time it starts.`)) void act(() => client.removeDevice(d.id), "Device removed");
              }}
            >
              <Icon name="trash" size={13} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
