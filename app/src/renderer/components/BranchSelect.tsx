// A branch pick with type-ahead over the project's local branches (GET /projects/:id/branches),
// for a ticket's branch and for base-branch overrides. Same shape as DriverModelSelect: a
// .select-looking trigger and a portaled popover with a search field; ↑/↓ move, Enter picks,
// Escape closes. null is the default pick (the first row); a typed name the list doesn't have can
// be picked too (labelled by `newLabel`).

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { BranchInfo } from "@harness/shared";
import { branchRows, pickableIds, rowId, type BranchRow } from "@harness/shared/state";
import { useStore } from "../state/store";
import { relativeTime, useNow } from "./bits";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { isTypeaheadKey, moveActive, settleActive } from "./modelCombobox";
import "./model-combobox.css";

const DEBOUNCE_MS = 80;
const LIMIT = 30;

export function BranchSelect({
  projectId,
  value,
  onChange,
  defaultLabel,
  newLabel,
  label = "Branch",
  disabled,
  compact,
}: {
  projectId: string;
  value: string | null;
  /** `info` is the picked branch's list entry (undefined for the default or a new name) */
  onChange: (value: string | null, info?: BranchInfo) => void;
  /** The null pick, e.g. "New branch harness/web-4" or "main (app default)" */
  defaultLabel: string;
  /** A typed name the list doesn't have, e.g. `Create "x"` */
  newLabel: (name: string) => string;
  /** aria-label of the trigger */
  label?: string;
  disabled?: boolean;
  /** Small inline variant (composer footer) */
  compact?: boolean;
}) {
  const { client } = useStore();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-o-${id ? encodeURIComponent(id) : "default"}`;

  // The service filters (substring, then in-order letters); stale answers are dropped.
  useEffect(() => {
    if (!open || !projectId) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      client.projectBranches(projectId, query.trim(), LIMIT).then(
        (b) => live && (setBranches(b), setError(null), setLoading(false)),
        (e: unknown) => live && (setBranches([]), setError(e instanceof Error ? e.message : String(e)), setLoading(false)),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, query, client, projectId]);

  const picked = value ?? "";
  const rows = open ? branchRows(branches, query, defaultLabel, newLabel) : [];
  const ids = pickableIds(rows);
  const current = settleActive(ids, active, picked);

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
  const pick = (row: BranchRow) => {
    if (row.kind === "invalid") return;
    close(true);
    if (row.value !== value) onChange(row.value, row.kind === "branch" ? row.info : undefined);
  };
  const pickId = (id: string) => {
    const row = rows.find((r) => rowId(r) === id);
    if (row) pick(row);
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

  // Place under the trigger (above when there's no room), again as the results change its height.
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
      setActive(moveActive(ids, current, e.key === "ArrowDown" ? "next" : "prev"));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (current !== null) pickId(current);
    } else if (e.key === "Tab") {
      e.preventDefault();
      close(true);
    }
  };

  const triggerStyle = compact ? { width: "auto", maxWidth: 280, minHeight: 26, height: 26, fontSize: 12 } : undefined;
  const triggerWidth = triggerRef.current?.getBoundingClientRect().width ?? 0;
  const shown = value ?? defaultLabel;

  return (
    <span className="model-select branch-select row" style={{ gap: 4, alignItems: "center", minWidth: 0 }} data-testid="branch-select">
      <button
        ref={triggerRef}
        type="button"
        className={`select model-combo-trigger ${value === null ? "" : "mono"}`}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        title={shown}
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
        <Icon name="branch" size={12} />
        <span className="truncate">{shown}</span>
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            className="model-combo branch-combo"
            data-above={place?.above || undefined}
            style={{
              left: place?.left ?? 0,
              top: place?.top ?? 0,
              width: Math.max(300, Math.min(440, triggerWidth)),
              maxHeight: place?.maxHeight ?? undefined,
              visibility: place ? undefined : "hidden",
            }}
          >
            <div className="branch-combo-search-row">
              <input
                ref={searchRef}
                className="model-combo-search"
                placeholder="Search or type a branch name…"
                value={query}
                spellCheck={false}
                role="combobox"
                aria-label="Search branches"
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
              {loading && <span className="spinner" title="Loading branches…" />}
            </div>
            <div className="model-combo-list" id={listId} role="listbox" aria-label="Branches">
              {error && <div className="model-combo-empty">Couldn't list branches: {error}</div>}
              {rows.map((r) => {
                const id = rowId(r);
                if (id === null) {
                  return (
                    <div key="__invalid" className="model-combo-empty branch-combo-invalid" role="presentation">
                      <Icon name="alert" size={11} /> {r.label}
                    </div>
                  );
                }
                return (
                  <div
                    key={id || "__default"}
                    id={optionId(id)}
                    role="option"
                    aria-selected={id === picked}
                    className={`model-combo-option ${id === current ? "active" : ""}`}
                    onMouseMove={() => id !== current && setActive(id)}
                    // Keep the focus in the search field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r)}
                  >
                    <span className={`truncate ${r.kind === "branch" ? "mono" : ""}`}>{r.label}</span>
                    <span className="branch-combo-meta">
                      {r.kind === "branch" && r.info.checkedOutAt && (
                        <span className="badge badge-outline" title={`Checked out at ${r.info.checkedOutAt}`}>
                          checked out
                        </span>
                      )}
                      {r.kind === "branch" && r.info.lastCommitAt > 0 && <span className="muted">{relativeTime(r.info.lastCommitAt, now)}</span>}
                      {id === picked && <Icon name="check" size={12} strokeWidth={2.25} />}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
