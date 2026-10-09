// The per-phase driver + model pick (app Settings, project settings, ticket settings): the trigger
// summarises the choices ("Opus 5.5 · Complete: Haiku 5.5"); its popover lists every signed-in
// driver's models down the left and a radio column per phase (Planning, Work, Review, Complete) on
// the right, one radio selected per column. The Defaults row (absent at app level) clears a phase, with the models it inherits listed under it.
// Arrow keys move over the rows and columns, Space/Enter picks, and typing filters the rows.

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { PHASE_LABELS, PHASES, type ModelInfo, type Phase, type PhaseChoice, type PhaseModels, type PhaseModelsPatch } from "@harness/shared";
import { filterPhaseGroups, modelCacheFor, phaseMatrix, phasePickPatch, type PhaseRow } from "@harness/shared/state";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { isTypeaheadKey } from "./modelCombobox";
import "./model-combobox.css";

type Line = { kind: "heading"; driver: string; label: string } | { kind: "row"; row: PhaseRow } | { kind: "help"; names: Record<Phase, string> };

/** The width a name has for itself in a phase column (64px less 2px of air a side). */
const HELP_COLUMN_WIDTH = 60;
const HELP_FONT = "11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
let measureCtx: CanvasRenderingContext2D | null | undefined;

/** Whether every inherited name fits under its radio; false means list them one per line instead. */
function helpFitsColumns(names: Record<Phase, string>): boolean {
  if (measureCtx === undefined) measureCtx = document.createElement("canvas").getContext("2d");
  if (!measureCtx) return Object.values(names).every((n) => n.length <= 9);
  measureCtx.font = HELP_FONT;
  return PHASES.every((p) => measureCtx!.measureText(names[p]).width <= HELP_COLUMN_WIDTH);
}

export function PhaseModelSelect({
  value,
  inherited,
  onChange,
  disabled,
  autoWidth,
  hint = "Settings apply to the next run.",
}: {
  /** This level's own choices */
  value: PhaseModels | null | undefined;
  /** What each phase inherits from the level above (inheritedPhaseModels); null at app level */
  inherited: Record<Phase, PhaseChoice> | null;
  /** A per-phase patch: one phase's new choice, or null to inherit */
  onChange: (patch: PhaseModelsPatch) => void;
  disabled?: boolean;
  /** Size to the summary instead of filling the row (settings rows) */
  autoWidth?: boolean;
  /** The help text under the field; null hides it */
  hint?: string | null;
}) {
  const { state, client, epoch } = useStore();
  const cache = modelCacheFor(client);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const choices = [...PHASES.map((p) => value?.[p]), ...(inherited ? PHASES.map((p) => inherited[p]) : [])];
  const signedIn = state.drivers.filter((d) => d.available && d.authenticated).map((d) => d.id);
  const ids = [...new Set([...signedIn, ...choices.map((c) => c?.driver)].filter((id): id is string => !!id))];
  const key = ids.join(",");
  useEffect(() => {
    cache.syncEpoch(epoch);
    for (const id of key ? key.split(",") : []) void cache.load(id);
  }, [cache, key, epoch]);

  const lists = Object.fromEntries(ids.map((id) => [id, cache.get(id)]));
  const models = Object.fromEntries(ids.map((id) => [id, lists[id]!.data?.models as ModelInfo[] | undefined]));
  const matrix = phaseMatrix(state.drivers, models, value, inherited);
  const loading = ids.some((id) => lists[id]!.loading && !lists[id]!.data);
  const driverNames = Object.fromEntries(state.drivers.map((d) => [d.id, d.name]));
  const problems = ids.flatMap((id) => {
    const p = lists[id]!.error ?? lists[id]!.data?.error;
    return p ? [`${driverNames[id] ?? id}: ${p}`] : [];
  });
  const problem = problems.length ? problems.join("\n") : null;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<{ row: string; phase: Phase } | null>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-grid`;
  const cellId = (row: string, phase: Phase) => `${baseId}-${phase}-${row ? encodeURIComponent(row) : "inherit"}`;

  const lines: Line[] = open
    ? [
        ...(matrix.inherit && !query.trim() ? [{ kind: "row" as const, row: matrix.inherit }, ...(matrix.inheritNames ? [{ kind: "help" as const, names: matrix.inheritNames }] : [])] : []),
        ...filterPhaseGroups(matrix.groups, query).flatMap((g) => [{ kind: "heading" as const, driver: g.driver, label: g.label }, ...g.rows.map((row) => ({ kind: "row" as const, row }))]),
      ]
    : [];
  const rowKeys = lines.flatMap((l) => (l.kind === "row" ? [l.row.key] : []));
  const cur = active && rowKeys.includes(active.row) ? active : rowKeys.length ? { row: rowKeys.includes(matrix.selected.work) ? matrix.selected.work : rowKeys[0]!, phase: active?.phase ?? ("work" as Phase) } : null;

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
  const pick = (row: PhaseRow, phase: Phase) => {
    setActive({ row: row.key, phase });
    if (matrix.selected[phase] !== row.key) onChange(phasePickPatch(phase, row));
  };

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
  }, [open, lines.length]);

  useLayoutEffect(() => {
    const input = searchRef.current;
    if (!open || !place || !input || document.activeElement === input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [open, place]);

  useLayoutEffect(() => {
    if (!open || !cur) return;
    document.getElementById(cellId(cur.row, cur.phase))?.scrollIntoView({ block: "nearest" });
  }, [open, cur?.row, cur?.phase, place]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!cur) return;
    const i = rowKeys.indexOf(cur.row);
    const c = PHASES.indexOf(cur.phase);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = rowKeys.length;
      setActive({ row: rowKeys[(i + (e.key === "ArrowDown" ? 1 : n - 1)) % n]!, phase: cur.phase });
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && (e.altKey || !query)) {
      e.preventDefault();
      setActive({ row: cur.row, phase: PHASES[(c + (e.key === "ArrowRight" ? 1 : PHASES.length - 1)) % PHASES.length]! });
    } else if (e.key === "Enter" || (e.key === " " && !query)) {
      e.preventDefault();
      const line = lines.find((l) => l.kind === "row" && l.row.key === cur.row);
      if (line?.kind === "row") pick(line.row, cur.phase);
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };

  const triggerStyle = autoWidth ? { width: "auto", maxWidth: 420, flex: "none" } : undefined;
  const triggerWidth = triggerRef.current?.getBoundingClientRect().width ?? 0;
  const cols = `minmax(150px, 1fr) repeat(${PHASES.length}, 64px)`;

  return (
    <span className="phase-model-select" data-testid="phase-model-select">
      <span className="model-select row" style={{ gap: 4, alignItems: "center", minWidth: autoWidth ? undefined : 0 }}>
        <button
          ref={triggerRef}
          type="button"
          className="select model-combo-trigger"
          aria-label="Models"
          aria-haspopup="grid"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          title={problem ? `Couldn't list models: ${problem}` : PHASES.map((p) => `${PHASE_LABELS[p]}: ${matrix.selected[p] === "" ? "inherited" : (driverNames[matrix.effective[p].driver] ?? matrix.effective[p].driver)}`).join("\n")}
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
          <span className="truncate" data-testid="phase-model-summary">
            {matrix.summary}
          </span>
        </button>
        {loading && <span className="spinner" title="Loading models…" />}
        {problem && !loading && (
          <span className="model-select-error" title={problem} style={{ color: "var(--amber, var(--red))", display: "inline-flex" }}>
            <Icon name="alert" size={12} />
          </span>
        )}
      </span>
      {hint && <span className="field-hint phase-model-hint">{hint}</span>}
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="model-combo phase-combo"
            data-above={place?.above || undefined}
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              width: Math.max(460, Math.min(560, triggerWidth)),
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
              aria-activedescendant={cur ? cellId(cur.row, cur.phase) : undefined}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(null);
              }}
              onKeyDown={onSearchKey}
            />
            <div className="phase-combo-head" style={{ gridTemplateColumns: cols }} role="presentation">
              <span />
              {PHASES.map((p) => (
                <span key={p} className="phase-combo-col">
                  {PHASE_LABELS[p]}
                </span>
              ))}
            </div>
            <div className="model-combo-list" id={listId} role="grid" aria-label="Model per phase">
              {lines.length === 0 && <div className="model-combo-empty">No models match</div>}
              {lines.map((l) =>
                l.kind === "help" ? (
                  <div key="help" role="row" className="phase-combo-help" data-testid="phase-defaults-help">
                    <div
                      role="gridcell"
                      aria-label={`Defaults: ${PHASES.map((p) => `${PHASE_LABELS[p]} ${l.names[p]}`).join(", ")}`}
                      className={helpFitsColumns(l.names) ? "columns" : "lines"}
                      style={helpFitsColumns(l.names) ? { gridTemplateColumns: cols } : undefined}
                    >
                      {helpFitsColumns(l.names) ? (
                        <>
                          <span aria-hidden />
                          {PHASES.map((p) => (
                            <span key={p} aria-hidden data-phase={p}>
                              {l.names[p]}
                            </span>
                          ))}
                        </>
                      ) : (
                        PHASES.map((p) => (
                          <div key={p} aria-hidden data-phase={p}>
                            <b>{PHASE_LABELS[p]}:</b> {l.names[p]}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                ) : l.kind === "heading" ? (
                  <div key={`h-${l.driver}`} className="model-combo-heading" role="presentation">
                    {l.label}
                  </div>
                ) : (
                  <div
                    key={l.row.key || "__inherit"}
                    role="row"
                    className={`phase-combo-row ${cur?.row === l.row.key ? "active" : ""}`}
                    style={{ gridTemplateColumns: cols }}
                    data-row={l.row.key || "inherit"}
                  >
                    <span className="truncate" role="rowheader" title={l.row.label}>
                      {l.row.label}
                    </span>
                    {PHASES.map((p) => {
                      const checked = matrix.selected[p] === l.row.key;
                      return (
                        <span
                          key={p}
                          id={cellId(l.row.key, p)}
                          role="radio"
                          aria-checked={checked}
                          aria-label={`${PHASE_LABELS[p]}: ${l.row.label}`}
                          data-phase={p}
                          className={`phase-combo-cell ${cur?.row === l.row.key && cur.phase === p ? "active" : ""}`}
                          onMouseMove={() => (cur?.row !== l.row.key || cur.phase !== p) && setActive({ row: l.row.key, phase: p })}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(l.row, p)}
                        >
                          <span className={`phase-radio ${checked ? "on" : ""}`} />
                        </span>
                      );
                    })}
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
