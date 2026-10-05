// A project's group pick (project settings): type-ahead over the groups other projects already
// have, and whatever's typed as a new group, so Enter either joins the group it completes to or
// starts one. Same shape as BranchSelect: a .select-looking trigger and a portaled popover with a
// search field; ↑/↓ move, Enter picks, Escape closes. The rows are groupRows in @harness/shared/state.

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { groupRowIds, groupRows, NO_GROUP_LABEL, type GroupRow } from "@harness/shared/state";
import { Icon } from "./Icon";
import { placeMenu, type MenuPlacement } from "./menuPlacement";
import { isTypeaheadKey, moveActive, settleActive } from "./modelCombobox";
import "./model-combobox.css";

export function GroupSelect({
  value,
  groups,
  onChange,
  disabled,
}: {
  value: string | null;
  /** Every group in use, alphabetically (projectGroups) */
  groups: readonly string[];
  onChange: (value: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState<string | null>(null);
  const [place, setPlace] = useState<MenuPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (id: string) => `${baseId}-o-${id ? encodeURIComponent(id) : "none"}`;

  const rows = open ? groupRows(groups, query) : [];
  const ids = groupRowIds(rows);
  // While something's typed the highlight starts on the best match (the first row), not on the
  // project's current group, so Enter joins what was typed.
  const current = settleActive(ids, active, query.trim() ? (ids[0] ?? "") : (value ?? ""));

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
  const pick = (row: GroupRow) => {
    if (row.kind === "invalid") return;
    close(true);
    if (row.value !== value) onChange(row.value);
  };
  const pickId = (id: string) => {
    const row = rows.find((r) => r.kind !== "invalid" && (r.value ?? "") === id);
    if (row) pick(row);
  };

  // Outside clicks close it; Escape (capture phase, swallowed) closes it rather than anything behind.
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

  // Place under the trigger (above when there's no room), again as the rows change its height.
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

  useLayoutEffect(() => {
    if (!open || current === null) return;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  }, [open, current, place]);

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Portaled, so React bubbles these to the trigger's ancestors.
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

  const triggerWidth = triggerRef.current?.getBoundingClientRect().width ?? 0;

  return (
    <span className="model-select row" style={{ gap: 4, alignItems: "center", minWidth: 0 }} data-testid="group-select">
      <button
        ref={triggerRef}
        type="button"
        className={`select model-combo-trigger ${value === null ? "muted" : ""}`}
        aria-label="Group"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
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
        <Icon name="folder" size={12} />
        <span className="truncate">{value ?? NO_GROUP_LABEL}</span>
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
              width: Math.max(260, Math.min(400, triggerWidth)),
              maxHeight: place?.maxHeight ?? undefined,
              visibility: place ? undefined : "hidden",
            }}
          >
            <div className="branch-combo-search-row">
              <input
                ref={searchRef}
                className="model-combo-search"
                placeholder="Search or type a new group…"
                value={query}
                spellCheck={false}
                role="combobox"
                aria-label="Search groups"
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
            </div>
            <div className="model-combo-list" id={listId} role="listbox" aria-label="Groups">
              {rows.map((r) => {
                if (r.kind === "invalid") {
                  return (
                    <div key="__invalid" className="model-combo-empty branch-combo-invalid" role="presentation">
                      <Icon name="alert" size={11} /> {r.label}
                    </div>
                  );
                }
                const id = r.value ?? "";
                return (
                  <div
                    key={`${r.kind}:${id}`}
                    id={optionId(id)}
                    role="option"
                    aria-selected={r.value === value}
                    className={`model-combo-option ${id === current ? "active" : ""}`}
                    onMouseMove={() => id !== current && setActive(id)}
                    // Keep the focus in the search field.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(r)}
                  >
                    <span className={`truncate ${r.kind === "none" ? "muted" : ""}`}>{r.label}</span>
                    {r.value === value && <Icon name="check" size={12} strokeWidth={2.25} />}
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
