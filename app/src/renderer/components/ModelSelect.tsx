// Model dropdown for one driver. "" (the first option) means "inherit / driver default" → null.

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { ModelInfo, TriageChoice } from "@harness/shared";
import { useStore } from "../state/store";
import { decodeChoice, driverModelChoices, encodeChoice, modelCacheFor, modelName, modelOptions } from "@harness/shared/state";
import { useDriverModels } from "../state/models";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { comboRows, isTypeaheadKey, moveActive, optionValues, settleActive } from "./modelCombobox";
import "./model-combobox.css";

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
 * A driver + model pick (watchers, New session, ticket details, project and app defaults) as a combobox: the trigger shows the
 * pick; its popover has a type-ahead search over every signed-in driver's models, grouped under a
 * heading per driver (a flat list when only one driver shows). Default comes first.
 */
export function DriverModelSelect({
  value,
  onChange,
  resolved,
  defaultLabel,
  disabled,
  autoWidth,
  compact,
  onlyDriver,
  inheritedModel,
}: {
  value: TriageChoice;
  onChange: (choice: TriageChoice) => void;
  /** What Default falls back to, named in the first option */
  resolved: TriageChoice;
  defaultLabel?: string;
  disabled?: boolean;
  /** Size to the picked label instead of filling the row (settings rows) */
  autoWidth?: boolean;
  /** Small inline variant (composer footer) */
  compact?: boolean;
  /** List only this driver's models (a ticket mid-run keeps its driver) */
  onlyDriver?: string;
  /** What a driver picked without a model falls back to, named in its "<driver> default" entry */
  inheritedModel?: (driver: string) => string | null;
}) {
  const { state, client, epoch } = useStore();
  const cache = modelCacheFor(client);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const signedIn = onlyDriver ? [onlyDriver] : state.drivers.filter((d) => d.available && d.authenticated).map((d) => d.id);
  const ids = [...new Set([...signedIn, value.driver, resolved.driver].filter((id): id is string => !!id))];
  const key = ids.join(",");
  useEffect(() => {
    cache.syncEpoch(epoch);
    for (const id of key ? key.split(",") : []) void cache.load(id);
  }, [cache, key, epoch]);

  const lists = Object.fromEntries(ids.map((id) => [id, cache.get(id)]));
  const models = Object.fromEntries(ids.map((id) => [id, lists[id]!.data?.models as ModelInfo[] | undefined]));
  const choices = driverModelChoices(state.drivers, models, value, resolved, { defaultLabel, onlyDriver, inheritedModel });
  const loading = ids.some((id) => lists[id]!.loading && !lists[id]!.data);
  const driverNames = Object.fromEntries(state.drivers.map((d) => [d.id, d.name]));
  const problems = ids.flatMap((id) => {
    const p = lists[id]!.error ?? lists[id]!.data?.error;
    return p ? [`${driverNames[id] ?? id}: ${p}`] : [];
  });
  const problem = problems.length ? problems.join("\n") : null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (v: string) => `${baseId}-o-${v ? encodeURIComponent(v) : "default"}`;

  const picked = encodeChoice(value);
  const rows = open ? comboRows(choices.default, choices.groups, query, driverNames) : [];
  const values = optionValues(rows);
  const current = settleActive(values, active, picked);

  const show = (q = "") => {
    if (disabled) return;
    setQuery(q);
    setActive(null);
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  const pick = (v: string) => {
    close(true);
    if (v !== picked) onChange(decodeChoice(v));
  };

  // Outside clicks close it; Escape (capture phase, swallowed) closes it rather than the modal behind.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) close(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      close(true);
    };
    addEventListener("mousedown", down);
    addEventListener("keydown", esc, true);
    return () => {
      removeEventListener("mousedown", down);
      removeEventListener("keydown", esc, true);
    };
  }, [open]);

  // Place under the trigger (above when there's no room), again as the filter changes its height.
  useLayoutEffect(() => {
    if (!open) return setPlace(null);
    const measure = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const pop = popRef.current;
      if (!anchor || !pop) return;
      const cap = pop.style.maxHeight;
      pop.style.maxHeight = "";
      const { width, height } = pop.getBoundingClientRect();
      pop.style.maxHeight = cap;
      setPlace(placeMenu({ anchor, width, height, vw: innerWidth, vh: innerHeight, align: "left" }));
    };
    measure();
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [open, rows.length]);

  // Focus the search once placed (hidden until then, it can't take the focus), caret after any type-ahead.
  useLayoutEffect(() => {
    const input = searchRef.current;
    if (!open || !place || !input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [open, place]);

  // Keep the active option in view.
  useLayoutEffect(() => {
    if (!open || current === null) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  }, [open, current, place]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Portaled, so React bubbles these to the trigger's ancestors (a form's submit, a card's Enter).
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive(moveActive(values, current, e.key === "ArrowDown" ? "next" : "prev"));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current !== null) pick(current);
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };

  const triggerStyle = {
    ...(compact ? { width: "auto", maxWidth: 260, minHeight: 26, height: 26, fontSize: 12 } : {}),
    ...(autoWidth ? { width: "auto", maxWidth: 360, flex: "none" } : {}),
  };
  const triggerWidth = triggerRef.current?.getBoundingClientRect().width ?? 0;

  return (
    <span className="model-select row" style={{ gap: 4, alignItems: "center", minWidth: autoWidth ? undefined : 0 }} data-testid="driver-model-select">
      <button
        ref={triggerRef}
        type="button"
        className="select model-combo-trigger"
        aria-label="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={problem ? `Couldn't list models: ${problem}` : choices.selectedLabel}
        style={triggerStyle}
        disabled={disabled}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (open) return;
          if (isTypeaheadKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            show(e.key);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="truncate">{choices.selectedLabel}</span>
      </button>
      {loading && <span className="spinner" title="Loading models…" />}
      {problem && !loading && (
        <span className="model-select-error" title={problem} style={{ color: "var(--amber, var(--red))", display: "inline-flex" }}>
          <Icon name="alert" size={12} />
        </span>
      )}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="model-combo"
            data-above={place?.above || undefined}
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              width: Math.max(260, Math.min(420, triggerWidth)),
              maxHeight: place?.maxHeight ?? undefined,
              visibility: place ? undefined : "hidden",
            }}
          >
            <input
              ref={searchRef}
              className="model-combo-search"
              placeholder="Search models…"
              value={query}
              role="combobox"
              aria-label="Search models"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={current !== null ? optionId(current) : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(null);
              }}
              onKeyDown={onSearchKey}
            />
            <div className="model-combo-list" id={listId} role="listbox" aria-label="Models">
              {rows.length === 0 && <div className="model-combo-empty">No models match</div>}
              {rows.map((r) =>
                r.kind === "heading" ? (
                  <div key={`h-${r.driver}`} className="model-combo-heading" role="presentation">
                    {r.label}
                  </div>
                ) : (
                  <div
                    key={r.value || "__default"}
                    id={optionId(r.value)}
                    role="option"
                    aria-selected={r.value === picked}
                    className={`model-combo-option ${r.value === current ? "active" : ""}`}
                    onMouseMove={() => r.value !== current && setActive(r.value)}
                    // Keep the focus in the search field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r.value)}
                  >
                    <span className="truncate">{r.label}</span>
                    {r.value === picked && <Icon name="check" size={12} strokeWidth={2.25} />}
                  </div>
                ),
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
