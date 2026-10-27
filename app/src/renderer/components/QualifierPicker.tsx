// The list that opens under a search field while its last word is `label:` or `project:`.

import type { QualifierOption } from "../state/qualifierPicker";
import { LabelDot } from "./Labels";

export function QualifierPickerList({ options, active, onPick, onHover, id }: { options: QualifierOption[]; active: number; onPick: (o: QualifierOption) => void; onHover?: (i: number) => void; id?: string }) {
  return (
    <ul className="qualifier-picker" role="listbox" aria-label={options[0]?.field === "project" ? "Projects" : "Labels"} data-testid="qualifier-picker" id={id}>
      {options.map((o, i) => (
        <li
          key={`${o.field}:${o.value}`}
          role="option"
          aria-selected={i === active}
          data-testid="qualifier-option"
          data-value={o.value}
          // Keep the focus (and the caret) in the field.
          onMouseDown={(e) => e.preventDefault()}
          onMouseMove={() => onHover?.(i)}
          onClick={() => onPick(o)}
        >
          <LabelDot color={o.color} />
          <span className="truncate">{o.label}</span>
          {o.detail && <span className="muted truncate">{o.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
