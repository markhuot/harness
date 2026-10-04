// Settings → Drivers: each driver opens into its own settings (sign-in, review model, the
// Anthropic API key for anthropic-api, and the long-lived token for claude-code), with the app's default driver + model below the list.

import { useEffect, useRef, useState, type ReactNode } from "react";
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
      {d.id === "claude-code" && settings && <ClaudeTokenRow settings={settings} />}
      {d.id === "github-copilot" && settings && <CopilotTokenRow settings={settings} />}
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
  return (
    <SecretRow
      testId="anthropic-api-key"
      title="API key"
      sub="Stored by the service; falls back to ANTHROPIC_API_KEY."
      label="Anthropic API key"
      placeholder="sk-ant-…"
      savedLabel="Key saved"
      isSet={settings.anthropicApiKeySet}
      save={(v) => client.updateSettings({ anthropicApiKey: v })}
      savedMessage="API key saved"
      clearedMessage="API key cleared"
    />
  );
}

/**
 * The long-lived token from `claude setup-token`. The service started by launchd can't always
 * read the Claude login in the Keychain, so runs use this instead when it's set. Hidden for a
 * service that predates the setting (claudeOauthTokenSet undefined).
 */
function ClaudeTokenRow({ settings }: { settings: PublicSettings }) {
  const { client, dispatch } = useStore();
  const act = useAction();
  if (settings.claudeOauthTokenSet === undefined) return null;
  const save = async (v: string | null) => {
    const out = await client.updateSettings({ claudeOauthToken: v });
    // The driver's sign-in status follows the token; refresh it so the badge updates.
    const drivers = await act(() => client.listDrivers());
    if (drivers) dispatch({ type: "drivers", drivers });
    return out;
  };
  return (
    <SecretRow
      testId="claude-oauth-token"
      title="Long-lived token"
      sub={
        <>
          Run <code>claude setup-token</code> in a terminal and paste the token. Runs use it instead of the Claude login in your Keychain, which the service can't always read when it starts at login.
        </>
      }
      label="Claude long-lived token"
      placeholder="sk-ant-oat01-…"
      savedLabel="Token saved"
      isSet={settings.claudeOauthTokenSet}
      save={save}
      savedMessage="Token saved"
      clearedMessage="Token cleared"
    />
  );
}

/**
 * A GitHub token for the Copilot CLI (COPILOT_GITHUB_TOKEN): a fine-grained personal access token
 * with the Copilot Requests permission. Like the Claude token, it saves runs from depending on the
 * Keychain login. Hidden for a service that predates the setting (copilotGithubTokenSet undefined).
 */
function CopilotTokenRow({ settings }: { settings: PublicSettings }) {
  const { client, dispatch } = useStore();
  const act = useAction();
  if (settings.copilotGithubTokenSet === undefined) return null;
  const save = async (v: string | null) => {
    const out = await client.updateSettings({ copilotGithubToken: v });
    const drivers = await act(() => client.listDrivers());
    if (drivers) dispatch({ type: "drivers", drivers });
    return out;
  };
  return (
    <SecretRow
      testId="copilot-github-token"
      title="GitHub token"
      sub={
        <>
          A fine-grained personal access token with the <b>Copilot Requests</b> permission (GitHub → Settings → Developer settings → Fine-grained tokens), or the output of <code>gh auth token</code>. Classic <code>ghp_</code> tokens don't work. Runs use it instead of the Copilot login in your Keychain, which the service can't always read when it starts at login.
        </>
      }
      label="GitHub token for Copilot"
      placeholder="github_pat_…"
      savedLabel="Token saved"
      isSet={settings.copilotGithubTokenSet}
      save={save}
      savedMessage="Token saved"
      clearedMessage="Token cleared"
    />
  );
}

/** A write-only secret setting: a password field until one is stored, then Replace / Clear. */
function SecretRow(props: {
  testId: string;
  title: string;
  sub: ReactNode;
  label: string;
  placeholder: string;
  savedLabel: string;
  isSet: boolean;
  /** PATCHes the setting: a string stores it, null clears it. */
  save: (value: string | null) => Promise<unknown>;
  savedMessage: string;
  clearedMessage: string;
}) {
  const act = useAction();
  const [value, setValue] = useState("");
  const [replacing, setReplacing] = useState(false);

  const saveValue = async () => {
    if (!value.trim()) return;
    const ok = await act(() => props.save(value.trim()), props.savedMessage);
    if (ok) {
      setValue("");
      setReplacing(false);
    }
  };

  return (
    <div className="settings-row" data-testid={props.testId}>
      <div className="settings-row-main">
        <div className="settings-row-title">{props.title}</div>
        <div className="settings-row-sub">{props.sub}</div>
      </div>
      <div className="settings-control" style={{ width: 320 }}>
        {props.isSet && !replacing ? (
          <>
            <span className="settings-key-saved grow">
              <Icon name="checkCircle" size={13} /> {props.savedLabel}
            </span>
            <button className="btn btn-sm" onClick={() => setReplacing(true)}>
              Replace
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => void act(() => props.save(null), props.clearedMessage)}>
              Clear
            </button>
          </>
        ) : (
          <>
            <input
              className="input mono"
              type="password"
              placeholder={props.placeholder}
              aria-label={props.label}
              value={value}
              autoFocus={replacing}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveValue();
                if (e.key === "Escape") setReplacing(false);
              }}
            />
            <button className="btn btn-sm btn-primary" disabled={!value.trim()} onClick={saveValue}>
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
