// Permission-mode dropdown (auto / ask / read only). With `inherited`, the first option is
// "Default (<inherited>)" and maps to null: the level inherits from the one above it.

import type { PermissionMode } from "@harness/shared";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES } from "@harness/shared";
import { permissionModeLabel } from "@harness/shared/state";

export { permissionModeLabel } from "@harness/shared/state";


export function PermissionModeSelect({
  value,
  onChange,
  inherited,
  disabled,
  compact,
}: {
  value: PermissionMode | null;
  onChange: (mode: PermissionMode | null) => void;
  /** What null resolves to here; omit for the global setting (no "default" option) */
  inherited?: PermissionMode;
  disabled?: boolean;
  /** Small inline variant (composer footer) */
  compact?: boolean;
}) {
  const style = compact ? { width: "auto", minHeight: 26, height: 26, fontSize: 12 } : undefined;
  const current = value ?? inherited;
  return (
    <select
      className="select"
      aria-label="Permission mode"
      data-testid="permission-mode"
      title={current ? `Permissions: ${PERMISSION_MODE_LABELS[current].description}` : "Permission mode"}
      style={style}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange((e.target.value || null) as PermissionMode | null)}
    >
      {inherited && <option value="">{compact ? `Default · ${permissionModeLabel(inherited)}` : `Default (${permissionModeLabel(inherited)})`}</option>}
      {PERMISSION_MODES.map((m) => (
        <option key={m} value={m}>
          {permissionModeLabel(m)}
        </option>
      ))}
    </select>
  );
}
