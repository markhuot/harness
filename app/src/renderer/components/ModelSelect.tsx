// Model dropdown for one driver. "" (the first option) means "inherit / driver default" → null.

import { useEffect, useSyncExternalStore } from "react";
import type { ModelInfo, TriageChoice } from "@harness/shared";
import { useStore } from "../state/store";
import { decodeChoice, driverModelChoices, encodeChoice, modelCacheFor, modelName, modelOptions } from "@harness/shared/state";
import { useDriverModels } from "../state/models";
import { Icon } from "./Icon";

export function ModelSelect({
  driver,
  value,
  onChange,
  inherited = null,
  defaultLabel,
  plainDefault,
  disabled,
  compact,
  showRefresh,
}: {
  driver: string;
  value: string | null;
  onChange: (model: string | null) => void;
  /** What null resolves to at this level (project / settings default), shown in the first option */
  inherited?: string | null;
  defaultLabel?: string;
  /** First option shows just defaultLabel (e.g. "Same as work") */
  plainDefault?: boolean;
  disabled?: boolean;
  /** Small inline variant (composer footer) */
  compact?: boolean;
  showRefresh?: boolean;
}) {
  const { client, epoch } = useStore();
  const { data, loading, error, refresh } = useDriverModels(client, driver, epoch);
  const models = data?.models;
  const options = modelOptions(models, value, { inherited, defaultLabel, plainDefault });
  const problem = error ?? data?.error ?? null;
  const style = compact ? { width: "auto", maxWidth: 220, minHeight: 26, height: 26, fontSize: 12 } : undefined;
  return (
    <span className="model-select row" style={{ gap: 4, alignItems: "center" }} data-driver={driver}>
      <select
        className="select"
        aria-label="Model"
        title={problem ? `Couldn't list models: ${problem}` : "Model"}
        style={style}
        value={value ?? ""}
        disabled={disabled || !driver}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {options.map((o) => (
          <option key={o.value || "__default"} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {loading && !data && <span className="spinner" title="Loading models…" />}
      {problem && !loading && (
        <span className="model-select-error" title={problem} style={{ color: "var(--amber, var(--red))", display: "inline-flex" }}>
          <Icon name="alert" size={12} />
        </span>
      )}
      {showRefresh && (
        <button type="button" className="btn btn-ghost btn-icon btn-sm" title="Refresh model list" disabled={loading} onClick={() => void refresh()}>
          <Icon name="refresh" size={12} />
        </button>
      )}
    </span>
  );
}

/** Small badge for a ticket that picked its own model. */
export function ModelBadge({ model, driver }: { model: string | null; driver: string }) {
  const { client, epoch } = useStore();
  const { data } = useDriverModels(client, model ? driver : "", epoch);
  if (!model) return null;
  return <ModelBadgeView name={modelName(data?.models as ModelInfo[] | undefined, model)} model={model} />;
}

export function ModelBadgeView({ name, model }: { name: string; model: string }) {
  return (
    <span className="badge badge-outline model-badge" title={`Model: ${model}`}>
      <Icon name="layers" size={10} />
      {name}
    </span>
  );
}

/**
 * One select for a driver + model pick (watchers): each signed-in driver is an <optgroup> of its
 * models, or a flat list when only one driver shows. "" (the first option) is Default.
 */
export function DriverModelSelect({
  value,
  onChange,
  resolved,
  defaultLabel,
  disabled,
  autoWidth,
}: {
  value: TriageChoice;
  onChange: (choice: TriageChoice) => void;
  /** What Default falls back to, named in the first option */
  resolved: TriageChoice;
  defaultLabel?: string;
  disabled?: boolean;
  /** Size to the picked label instead of filling the row (settings rows) */
  autoWidth?: boolean;
}) {
  const { state, client, epoch } = useStore();
  const cache = modelCacheFor(client);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const ids = [...new Set([...state.drivers.filter((d) => d.available && d.authenticated).map((d) => d.id), ...(value.driver ? [value.driver] : [])])];
  const key = ids.join(",");
  useEffect(() => {
    cache.syncEpoch(epoch);
    for (const id of ids) void cache.load(id);
    // ids is derived from key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, key, epoch]);

  const lists = Object.fromEntries(ids.map((id) => [id, cache.get(id)]));
  const models = Object.fromEntries(ids.map((id) => [id, lists[id]!.data?.models as ModelInfo[] | undefined]));
  const choices = driverModelChoices(state.drivers, models, value, resolved, { defaultLabel });
  const loading = ids.some((id) => lists[id]!.loading && !lists[id]!.data);
  const problems = ids.flatMap((id) => {
    const p = lists[id]!.error ?? lists[id]!.data?.error;
    return p ? [`${state.drivers.find((d) => d.id === id)?.name ?? id}: ${p}`] : [];
  });
  const problem = problems.length ? problems.join("\n") : null;

  return (
    <span className="model-select row" style={{ gap: 4, alignItems: "center" }} data-testid="driver-model-select">
      <select
        className="select"
        aria-label="Model"
        title={problem ? `Couldn't list models: ${problem}` : choices.selectedLabel}
        style={autoWidth ? { width: "auto", maxWidth: 360 } : undefined}
        value={encodeChoice(value)}
        disabled={disabled}
        onChange={(e) => onChange(decodeChoice(e.target.value))}
      >
        <option value="">{choices.default.label}</option>
        {choices.groups.map((g) =>
          g.label === null ? (
            g.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))
          ) : (
            <optgroup key={g.driver} label={g.label}>
              {g.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ),
        )}
      </select>
      {loading && <span className="spinner" title="Loading models…" />}
      {problem && !loading && (
        <span className="model-select-error" title={problem} style={{ color: "var(--amber, var(--red))", display: "inline-flex" }}>
          <Icon name="alert" size={12} />
        </span>
      )}
    </span>
  );
}
