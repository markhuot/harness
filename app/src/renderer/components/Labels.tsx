// Label chips: the label's color as a soft wash with readable text in the active theme (the
// project key badge's rule), a color dot, and the picker that recolors a label.

import { useState } from "react";
import { PROJECT_COLORS, projectColorHex, type LabelInfo } from "@harness/shared";
import { projectKeyColors } from "@harness/shared/themes";
import { activeTheme } from "../../main/theme";
import { useTheme } from "../state/theme";
import { useAction, useStore } from "../state/store";
import { addLabel, labelSuggestions, removeLabel } from "../state/labelEdit";
import { Icon } from "./Icon";

/** The colors of a label by name, from the collection (a label the collection doesn't have yet gets the accent). */
export function labelColorOf(labels: readonly LabelInfo[], name: string): string | null {
  return labels.find((l) => l.name === name)?.color ?? null;
}

export function useLabelColors(color: string | null | undefined) {
  const theme = useTheme();
  return projectKeyColors(color, activeTheme(theme).tokens);
}

/** A label on a card: colored, one line, long names cut short with the full name in the tooltip. */
export function LabelChip({ name, color }: { name: string; color: string | null | undefined }) {
  const { bg, fg } = useLabelColors(color);
  return (
    <span className="label-chip" data-label={name} title={name} style={{ background: bg, color: fg }}>
      <span className="truncate">{name}</span>
    </span>
  );
}

/** A solid dot in the label's color (the sidebar row, the picker). */
export function LabelDot({ color }: { color: string | null | undefined }) {
  return <span className="label-dot" style={{ background: projectColorHex(color) ?? "var(--accent)" }} />;
}

/** The row's color picker: the project color presets (the only colors a label takes). */
function LabelColorPicker({ value, onPick }: { value: string; onPick: (color: string) => void }) {
  return (
    <div className="color-picker label-color-picker" role="radiogroup" aria-label="Label color" data-testid="label-colors">
      {PROJECT_COLORS.map((c) => (
        <button key={c.id} type="button" role="radio" aria-checked={value === c.id} className="color-swatch" data-color={c.id} title={c.name} style={{ background: c.hex }} onClick={() => onPick(c.id)} />
      ))}
    </div>
  );
}

/**
 * The Labels row of a ticket: its labels as chips with a remove ×, a dot that opens the color
 * picker, and an add field that autocompletes existing labels and creates a new one on Enter. The
 * whole new list goes to `onSave`.
 */
export function LabelsEditor({ labels, editable, onSave }: { labels: readonly string[]; editable: boolean; onSave: (labels: string[]) => void }) {
  const { state, client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoloring, setRecoloring] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const suggestions = labelSuggestions(state.labels, labels, text);
  const add = (typed: string) => {
    const r = addLabel(state.labels, labels, typed);
    if ("error" in r) return setError(r.error);
    setError(null);
    setText("");
    if (r.labels.length !== labels.length) onSave(r.labels);
  };
  return (
    <>
      <dt>Labels</dt>
      <dd className="labels-row" data-testid="labels-editor">
        <div className="labels-chips">
          {labels.map((name) => {
            const label = state.labels.find((l) => l.name === name);
            return (
              <span key={name} className="label-edit">
                <EditableChip name={name} color={label?.color ?? null} editable={editable} onColor={() => setRecoloring(recoloring === name ? null : name)} onRemove={() => onSave(removeLabel(labels, name))} />
                {recoloring === name && label && (
                  <LabelColorPicker
                    value={label.color}
                    onPick={(color) => {
                      setRecoloring(null);
                      void act(() => client.setLabelColor(name, color));
                    }}
                  />
                )}
              </span>
            );
          })}
        </div>
        {editable && (
          <div className="label-add">
            <input
              className="input"
              aria-label="Add label"
              data-testid="label-add"
              placeholder="Add label…"
              value={text}
              onChange={(e) => (setText(e.target.value), setError(null))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), add(text));
                else if (e.key === "Escape") (setText(""), setError(null));
              }}
            />
            {focused && text.trim() && suggestions.length > 0 && (
              <ul className="label-suggestions" role="listbox" aria-label="Labels" data-testid="label-suggestions">
                {suggestions.map((l) => (
                  <li key={l.name} role="option" aria-selected={false} data-label={l.name} onMouseDown={(e) => (e.preventDefault(), add(l.name))}>
                    <LabelDot color={l.color} />
                    <span className="truncate">{l.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && (
          <span className="field-hint" role="alert" data-testid="label-error" style={{ color: "var(--red)" }}>
            {error}
          </span>
        )}
      </dd>
    </>
  );
}

function EditableChip({ name, color, editable, onColor, onRemove }: { name: string; color: string | null; editable: boolean; onColor: () => void; onRemove: () => void }) {
  const { bg, fg } = useLabelColors(color);
  return (
    <span className="label-chip editable" data-label={name} title={name} style={{ background: bg, color: fg }}>
      {editable && (
        <button type="button" className="label-chip-dot" aria-label={`Color of ${name}`} data-testid="label-color" onClick={onColor}>
          <LabelDot color={color} />
        </button>
      )}
      <span className="truncate">{name}</span>
      {editable && (
        <button type="button" className="label-chip-x" aria-label={`Remove ${name}`} onClick={onRemove}>
          <Icon name="x" size={9} strokeWidth={2.5} />
        </button>
      )}
    </span>
  );
}
