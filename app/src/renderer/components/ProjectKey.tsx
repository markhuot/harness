// The project's key badge ("HAR") in the project's color, and the color picker in project
// settings: Default (the theme accent), the eleven presets, and Custom (the native color panel).

import { useEffect, useRef, useState } from "react";
import { normalizeProjectColor, PROJECT_COLORS, projectColorHex, type Project } from "@harness/shared";
import { projectKeyColors } from "@harness/shared/themes";
import { activeTheme } from "../../main/theme";
import { useTheme } from "../state/theme";

export function ProjectKey({ project, size, color }: { project: Pick<Project, "key" | "color">; size?: "sm" | "lg"; color?: string | null }) {
  const theme = useTheme();
  const { bg, fg } = projectKeyColors(color !== undefined ? color : project.color, activeTheme(theme).tokens);
  return (
    <span className={`project-key${size ? ` ${size}` : ""}`} style={{ background: bg, color: fg }}>
      {project.key.slice(0, 3)}
    </span>
  );
}

export function ProjectColorPicker({ value, onChange, onPreview }: { value: string | null; onChange: (color: string | null) => void; onPreview?: (color: string | undefined) => void }) {
  const current = normalizeProjectColor(value) ?? null;
  const custom = current !== null && current.startsWith("#");
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (custom ? current : null);
  // React's onChange fires on every drag step of the native panel; save once, on the DOM
  // "change" event (the panel closes or the pick settles), and only preview in between. The
  // preview holds until the saved color comes back, so nothing flickers to the old one.
  const handlers = useRef({ onChange, onPreview });
  handlers.current = { onChange, onPreview };
  useEffect(() => {
    setDraft(null);
    handlers.current.onPreview?.(undefined);
  }, [current]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const done = () => handlers.current.onChange(el.value);
    el.addEventListener("change", done);
    return () => el.removeEventListener("change", done);
  }, []);

  return (
    <div className="color-picker" role="radiogroup" aria-label="Project color">
      <button type="button" role="radio" aria-checked={current === null} className="color-swatch default" title="Default" onClick={() => onChange(null)} />
      {PROJECT_COLORS.map((c) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={current === c.id}
          className="color-swatch"
          data-color={c.id}
          title={c.name}
          style={{ background: c.hex }}
          onClick={() => onChange(c.id)}
        />
      ))}
      <label role="radio" aria-checked={custom} className={`color-swatch custom${shown ? " set" : ""}`} title={custom ? `Custom (${current})` : "Custom…"} style={shown ? { background: shown } : undefined}>
        <input
          ref={input}
          type="color"
          aria-label="Custom color"
          value={shown ?? projectColorHex(current) ?? "#5e6ad2"}
          onChange={(e) => {
            setDraft(e.target.value);
            onPreview?.(e.target.value);
          }}
        />
      </label>
    </div>
  );
}
