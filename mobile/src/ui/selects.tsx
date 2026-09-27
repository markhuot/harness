// Model and permission-mode pickers (the desktop's <select>s) as tappable rows / chips that open
// a native action sheet. Option lists come from the shared helpers.

import { Pressable, Text, View } from "react-native";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "@harness/shared";
import { modelName, modelOptions, permissionModeLabel } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { useDriverModels } from "../state/models";
import { Badge, Spinner } from "./kit";
import { Icon } from "./Icon";
import { pick } from "./pick";
import { haptic } from "./haptics";

/** A compact value button: "Label ▾". */
export function PickerButton({ label, onPress, disabled, icon, loading, problem }: { label: string; onPress: () => void; disabled?: boolean; icon?: Parameters<typeof Icon>[0]["name"]; loading?: boolean; problem?: string | null }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={() => {
        haptic("select");
        onPress();
      }}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, opacity: disabled ? 0.5 : pressed ? 0.7 : 1, maxWidth: 260 })}
    >
      {icon && <Icon name={icon} size={13} color={c.text2} />}
      <Text style={{ color: c.text, fontSize: 14, flexShrink: 1 }} numberOfLines={1} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
      {loading ? <Spinner /> : problem ? <Icon name="alert" size={12} color={c.amber} /> : <Icon name="chevronDown" size={12} color={c.text3} />}
    </Pressable>
  );
}

export function ModelPicker({
  driver,
  value,
  onChange,
  inherited = null,
  defaultLabel,
  plainDefault,
  disabled,
  title = "Model",
}: {
  driver: string;
  value: string | null;
  onChange: (m: string | null) => void;
  inherited?: string | null;
  defaultLabel?: string;
  plainDefault?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const { client, epoch } = useStore();
  const { data, loading, error, refresh } = useDriverModels(client, driver, epoch);
  const options = modelOptions(data?.models, value, { inherited, defaultLabel, plainDefault });
  const current = options.find((o) => o.value === (value ?? "")) ?? options[0]!;
  const problem = error ?? data?.error ?? null;
  const open = async () => {
    const choice = await pick({
      title,
      message: problem ? `Couldn't list models: ${problem}` : undefined,
      choices: [...options.map((o) => ({ value: o.value, label: o.label })), { value: "__refresh", label: "Refresh model list" }],
      selected: value ?? "",
    });
    if (choice === undefined) return;
    if (choice === "__refresh") return void refresh();
    onChange(choice || null);
  };
  return <PickerButton label={current.label} onPress={open} disabled={disabled || !driver} icon="layers" loading={loading && !data} problem={problem} />;
}

export function PermissionPicker({ value, inherited, onChange, disabled }: { value: PermissionMode | null; inherited?: PermissionMode; onChange: (m: PermissionMode | null) => void; disabled?: boolean }) {
  const label = value ? permissionModeLabel(value) : inherited ? `Default · ${permissionModeLabel(inherited)}` : "Default";
  const open = async () => {
    const choices = [
      ...(inherited ? [{ value: "" as const, label: `Default (${permissionModeLabel(inherited)})` }] : []),
      ...PERMISSION_MODES.map((m) => ({ value: m, label: `${permissionModeLabel(m)} — ${PERMISSION_MODE_LABELS[m].description}` })),
    ];
    const v = await pick<PermissionMode | "">({ title: "Permission mode", choices, selected: value ?? "" });
    if (v === undefined) return;
    onChange(v || null);
  };
  return <PickerButton label={label} onPress={open} disabled={disabled} icon="shield" />;
}

/** Small badge for a ticket that picked its own model. */
export function ModelBadge({ model, driver }: { model: string | null; driver: string }) {
  const { client, epoch } = useStore();
  const { data } = useDriverModels(client, model ? driver : "", epoch);
  if (!model) return null;
  return (
    <Badge outline icon="layers">
      {modelName(data?.models, model)}
    </Badge>
  );
}

export function Row({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>{children}</View>;
}
