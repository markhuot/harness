// Model dropdown for one driver. "" (the first option) means "inherit / driver default" → null.

import type { ModelInfo } from "@harness/shared";
import { useStore } from "../state/store";
import { modelName, modelOptions } from "@harness/shared/state";
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
