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
}: {
  value: PermissionMode | null;
  onChange: (mode: PermissionMode | null) => void;
  /** What null resolves to here; omit for the global setting (no "default" option) */
  inherited?: PermissionMode;
  disabled?: boolean;
}) {
  const current = value ?? inherited;
  return (
    <select
      className="select"
      aria-label="Permission mode"
      data-testid="permission-mode"
      title={current ? `Permissions: ${PERMISSION_MODE_LABELS[current].description}` : "Permission mode"}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => onChange((e.target.value || null) as PermissionMode | null)}
    >
      {inherited && <option value="">{`Default (${permissionModeLabel(inherited)})`}</option>}
      {PERMISSION_MODES.map((m) => (
        <option key={m} value={m}>
          {permissionModeLabel(m)}
        </option>
      ))}
    </select>
  );
}
