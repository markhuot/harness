// Label chips: the label's color as a soft wash with readable text in the active theme (the
// project key badge's rule), a color dot, and the picker that recolors a label.

import { useState } from "react";
import { PROJECT_COLORS, keyLabel, projectColorHex, type LabelInfo, type Ticket } from "@harness/shared";
import { projectKeyColors } from "@harness/shared/themes";
import { activeTheme } from "../../main/theme";
import { useTheme } from "../state/theme";
import { useAction, useStore } from "../state/store";
import { addLabel, labelOptions, removeLabel, type LabelOption } from "../state/labelEdit";
import { Modal } from "./bits";
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
  const [hi, setHi] = useState(0);
  const options = labelOptions(state.labels, labels, text, "add");
  const add = (typed: string) => {
    const r = addLabel(state.labels, labels, typed);
    if ("error" in r) return setError(r.error);
    setError(null);
    setText("");
    setHi(0);
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
              onChange={(e) => (setText(e.target.value), setError(null), setHi(0))}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.preventDefault(), add(text.trim() && options[hi] ? options[hi]!.name : text));
                else if (e.key === "ArrowDown" && options.length) (e.preventDefault(), setHi((hi + 1) % options.length));
                else if (e.key === "ArrowUp" && options.length) (e.preventDefault(), setHi((hi + options.length - 1) % options.length));
                else if (e.key === "Escape") (setText(""), setError(null));
              }}
            />
            {focused && options.length > 0 && <LabelOptionList options={options} active={hi} onPick={(o) => add(o.name)} />}
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

/** The picker's rows: a label's dot and name, or "Create “name”" for a new one. */
function LabelOptionList({ options, active, onPick }: { options: LabelOption[]; active: number; onPick: (o: LabelOption) => void }) {
  return (
    <ul className="label-suggestions" role="listbox" aria-label="Labels" data-testid="label-suggestions">
      {options.map((o, i) => (
        <li key={`${o.kind}:${o.name}`} role="option" aria-selected={i === active} data-label={o.name} data-create={o.kind === "create" || undefined} className={i === active ? "active" : undefined} onMouseDown={(e) => (e.preventDefault(), onPick(o))}>
          {o.kind === "create" ? <Icon name="plus" size={11} /> : <LabelDot color={o.color} />}
          <span className="truncate">{o.kind === "create" ? `Create “${o.name}”` : o.name}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The palette's "Add label…" and "Remove label…" for the ticket in view: a typeahead over the
 * labels the ticket doesn't have (add, with "Create" for a new name) or does have (remove).
 */
export function LabelPickerModal({ ticket, mode, onClose }: { ticket: Ticket; mode: "add" | "remove"; onClose: () => void }) {
  const { state, client } = useStore();
  const act = useAction();
  const [text, setText] = useState("");
  const [hi, setHi] = useState(0);
  const current = ticket.labels ?? [];
  const options = labelOptions(state.labels, current, text, mode);
  const pick = async (o: LabelOption | undefined) => {
    if (!o) return;
    const labels = mode === "add" ? [...current, o.name] : removeLabel(current, o.name);
    if (await act(() => client.updateTicket(ticket.key, { labels }), mode === "add" ? `Added ${o.name}` : `Removed ${o.name}`)) onClose();
  };
  return (
    <Modal onClose={onClose}>
      <div className="modal-head">
        <strong>{mode === "add" ? "Add label" : "Remove label"}</strong>
        <span className="muted mono">{keyLabel(ticket)}</span>
      </div>
      <div className="modal-body label-picker" data-testid="label-picker">
        <input
          autoFocus
          className="input"
          aria-label={mode === "add" ? "Label to add" : "Label to remove"}
          data-testid="label-picker-input"
          placeholder={mode === "add" ? "Find or create a label…" : "Find a label…"}
          value={text}
          onChange={(e) => (setText(e.target.value), setHi(0))}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), void pick(options[hi]));
            else if (e.key === "ArrowDown" && options.length) (e.preventDefault(), setHi((hi + 1) % options.length));
            else if (e.key === "ArrowUp" && options.length) (e.preventDefault(), setHi((hi + options.length - 1) % options.length));
          }}
        />
        {options.length > 0 ? <LabelOptionList options={options} active={hi} onPick={(o) => void pick(o)} /> : <div className="field-hint">{mode === "add" ? "Type a name to create a label." : "This ticket has no matching labels."}</div>}
      </div>
    </Modal>
  );
}
