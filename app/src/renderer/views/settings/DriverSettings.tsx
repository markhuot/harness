// Settings → Drivers: each driver opens into its own settings (sign-in, review model, and the
// Anthropic API key for anthropic-api), with the app's default driver + model below the list.

import { useEffect, useRef, useState } from "react";
import type { DriverInfo, PublicSettings } from "@harness/shared";
import { useAction, useStore } from "../../state/store";
import { modelCacheFor, settingsChoice, settingsChoicePatch } from "@harness/shared/state";
import { DriverModelSelect, ModelSelect } from "../../components/ModelSelect";
import { Icon } from "../../components/Icon";
import { Row, Section } from "../Settings";
import "./drivers.css";

function driverBadge(d: DriverInfo) {
  if (!d.available) return <span className="badge badge-red">Unavailable</span>;
  if (!d.authenticated) return <span className="badge badge-amber">Not signed in</span>;
  return (
    <span className="badge badge-green">
      <Icon name="check" /> Ready
    </span>
  );
}

export function DriversSection() {
  const { state, client, dispatch, epoch } = useStore();
  const act = useAction();
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const settings = state.settings;

  const reload = async () => {
    setLoading(true);
    const drivers = await act(() => client.listDrivers());
    if (drivers) dispatch({ type: "drivers", drivers });
    setLoading(false);
  };

  useEffect(() => {
    if (epoch > 0) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // A new / cleared API key changes what anthropic-api can list.
  const keySet = useRef(settings?.anthropicApiKeySet);
  useEffect(() => {
    if (keySet.current === settings?.anthropicApiKeySet) return;
    keySet.current = settings?.anthropicApiKeySet;
    void modelCacheFor(client).load("anthropic-api", true);
  }, [client, settings?.anthropicApiKeySet]);

  return (
    <Section
      id="drivers"
      title="Drivers"
      desc="Open a driver for its sign-in and models. Tickets and projects can pick their own model; the default below applies when they don't."
      actions={
        <button className="btn btn-ghost btn-sm" onClick={reload} disabled={loading} title="Refresh drivers">
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
          Refresh
        </button>
      }
    >
      <div className="card-surface settings-card">
        {state.drivers.length === 0 && <div className="empty">No drivers reported by the service.</div>}
        {state.drivers.map((d) => (
          <div key={d.id} className="driver-item">
            <button className={`settings-row link driver-row${open === d.id ? " open" : ""}`} data-driver-row={d.id} aria-expanded={open === d.id} onClick={() => setOpen((cur) => (cur === d.id ? null : d.id))}>
              <div className="settings-row-main">
                <div className="settings-row-title">
                  {d.name}
                  {driverBadge(d)}
                  {settings?.defaultDriver === d.id && <span className="badge badge-accent">Default</span>}
                </div>
                <div className="settings-row-sub">{d.description}</div>
              </div>
              <Icon name={open === d.id ? "chevronDown" : "chevronRight"} size={14} />
            </button>
            {open === d.id && <DriverPanel driver={d} settings={settings} />}
          </div>
        ))}
      </div>
      {settings && <DefaultModelCard settings={settings} />}
    </Section>
  );
}

/** One driver's own settings, shown under its row. */
function DriverPanel({ driver: d, settings }: { driver: DriverInfo; settings: PublicSettings | null }) {
  const { client, toast } = useStore();
  const act = useAction();

  const login = async () => {
    const res = await act(() => client.loginDriver(d.id));
    if (!res) return;
    if (res.url) await window.harness?.openExternal(res.url);
    if (res.message) toast(res.message, "info");
  };

  return (
    <div className="driver-panel" data-testid={`driver-settings-${d.id}`}>
      {(d.detail || d.supportsLogin) && (
        <Row title="Status" sub={d.detail ?? (d.authenticated ? "Signed in." : "Not signed in.")}>
          {d.supportsLogin && (
            <button className="btn btn-sm" onClick={login}>
              <Icon name="key" size={12} />
              {d.authenticated ? "Log in again" : "Log in"}
            </button>
          )}
        </Row>
      )}
      {d.id === "anthropic-api" && settings && <AnthropicKeyRow settings={settings} />}
      {settings && (
        <Row title="Review model" sub="Model for agent review runs on this driver.">
          <div data-testid={`model-settings-${d.id}`}>
            <ModelSelect
              driver={d.id}
              value={settings.reviewModels[d.id] ?? null}
              defaultLabel="Same as work"
              plainDefault
              onChange={(m) => void act(() => client.updateSettings({ reviewModels: { [d.id]: m } }))}
              showRefresh
            />
          </div>
        </Row>
      )}
    </div>
  );
}

function AnthropicKeyRow({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);

  const saveKey = async () => {
    if (!apiKey.trim()) return;
    const ok = await act(() => client.updateSettings({ anthropicApiKey: apiKey.trim() }), "API key saved");
    if (ok) {
      setApiKey("");
      setReplacing(false);
    }
  };

  return (
    <div className="settings-row" data-testid="anthropic-api-key">
      <div className="settings-row-main">
        <div className="settings-row-title">API key</div>
        <div className="settings-row-sub">Stored by the service; falls back to ANTHROPIC_API_KEY.</div>
      </div>
      <div className="settings-control" style={{ width: 320 }}>
        {settings.anthropicApiKeySet && !replacing ? (
          <>
            <span className="settings-key-saved grow">
              <Icon name="checkCircle" size={13} /> Key saved
            </span>
            <button className="btn btn-sm" onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => void act(() => client.updateSettings({ anthropicApiKey: null }), "API key cleared")}>
              Clear
            </button>
          </>
        ) : (
          <>
            <input
              className="input mono"
              type="password"
              placeholder="sk-ant-…"
              aria-label="Anthropic API key"
              value={apiKey}
              autoFocus={replacing}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveKey();
                if (e.key === "Escape") setReplacing(false);
              }}
            />
            <button className="btn btn-sm btn-primary" disabled={!apiKey.trim()} onClick={saveKey}>
              Save
            </button>
            {replacing && (
              <button className="btn btn-sm btn-ghost" onClick={() => setReplacing(false)}>
                Cancel
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The app's default driver + model, right under the driver list. */
function DefaultModelCard({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  return (
    <div className="card-surface settings-card driver-default" data-testid="default-model">
      <Row title="Default model" sub="Used for new sessions unless the project or ticket picks its own.">
        <DriverModelSelect
          value={settingsChoice(settings)}
          resolved={{ driver: settings.defaultDriver, model: null }}
          defaultLabel="Driver default"
          autoWidth
          onChange={(c) => void act(() => client.updateSettings(settingsChoicePatch(c, settings)))}
        />
      </Row>
    </div>
  );
}
