// The desktop's <select>s as native iOS pull-down menus: a SwiftUI Menu whose label shows the
// current value with the ⌃⌄ select glyph, holding an inline Picker (checkmark on the selection) and
// an optional section of actions. Option lists come from the shared helpers.

import { useState } from "react";
import { View } from "react-native";
import { Button as SButton, Host, HStack, Image, Menu, Picker, ProgressView, Section, Text as SText, VStack } from "@expo/ui/swift-ui";
import { accessibilityLabel, controlSize, disabled as disabledMod, font, foregroundStyle, lineLimit, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES, type PermissionMode } from "@harness/shared";
import { modelName, modelOptions, permissionModeLabel } from "@harness/shared/state";
import { selectedLabel, type SelectOption } from "../lib/selectOptions";
import { useTheme } from "../state/app";
import { useStore } from "../state/store";
import { useDriverModels } from "../state/models";
import { Badge } from "./kit";
import { haptic } from "./haptics";

export type { SelectOption };

export interface SelectAction {
  label: string;
  /** SF Symbol */
  systemImage?: string;
  onPress: () => void;
}

/**
 * A native select. `label` overrides the trigger text (defaults to the selected option's label);
 * `title` heads the option list; `actions` go in their own section below the options.
 */
export function Select<V extends string>({
  value,
  options,
  onChange,
  label,
  placeholder = "Choose…",
  title,
  actions,
  disabled,
  loading,
  problem,
  accessibilityName,
}: {
  value: V;
  options: SelectOption<V>[];
  onChange: (v: V) => void;
  label?: string;
  placeholder?: string;
  title?: string;
  actions?: SelectAction[];
  disabled?: boolean;
  loading?: boolean;
  problem?: string | null;
  accessibilityName?: string;
}) {
  const { c, resolved } = useTheme();
  // The Picker keeps its own selection. Remount it after every pick so it always shows `value`,
  // including when the parent refuses a choice (a disabled driver, a failed save).
  const [nonce, setNonce] = useState(0);
  const text = label ?? selectedLabel(options, value, placeholder);
  const tint = disabled ? c.text3 : c.accent;
  const hasOptions = options.length > 0;
  return (
    <View style={{ maxWidth: 280, opacity: disabled ? 0.6 : 1 }}>
      <Host matchContents colorScheme={resolved}>
        <Menu
          modifiers={[disabledMod(!!disabled), accessibilityLabel(accessibilityName ? `${accessibilityName}, ${text}` : text)]}
          label={
            <HStack spacing={4}>
              <SText modifiers={[font({ size: 15 }), foregroundStyle(tint), lineLimit(1)]}>{text}</SText>
              {loading ? (
                <ProgressView modifiers={[controlSize("mini")]} />
              ) : problem ? (
                <Image systemName="exclamationmark.triangle.fill" size={12} color={c.amber} />
              ) : (
                <Image systemName="chevron.up.chevron.down" size={11} color={tint} />
              )}
            </HStack>
          }
        >
          {hasOptions && (
            <Section title={title}>
              <Picker
                key={nonce}
                label={title ?? ""}
                selection={value}
                modifiers={[pickerStyle("inline")]}
                onSelectionChange={(v) => {
                  setNonce((n) => n + 1);
                  const opt = options.find((o) => o.value === v);
                  if (!opt || opt.disabled || v === value) return;
                  haptic("select");
                  onChange(v as V);
                }}
              >
                {options.map((o) =>
                  o.subtitle ? (
                    <VStack key={o.value} modifiers={[tag(o.value), disabledMod(!!o.disabled)]}>
                      <SText>{o.label}</SText>
                      <SText>{o.subtitle}</SText>
                    </VStack>
                  ) : (
                    <SText key={o.value} modifiers={[tag(o.value), disabledMod(!!o.disabled)]}>
                      {o.label}
                    </SText>
                  ),
                )}
              </Picker>
            </Section>
          )}
          {!!(problem || actions?.length) && (
            <Section title={problem ?? undefined}>
              {(actions ?? []).map((a) => (
                <SButton key={a.label} label={a.label} systemImage={a.systemImage as never} onPress={a.onPress} />
              ))}
            </Section>
          )}
        </Menu>
      </Host>
    </View>
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
  const problem = error ?? data?.error ?? null;
  return (
    <Select
      value={value ?? ""}
      options={options}
      onChange={(m) => onChange(m || null)}
      title={title}
      accessibilityName={title}
      disabled={disabled || !driver}
      loading={loading && !data}
      problem={problem ? `Couldn't list models: ${problem}` : null}
      actions={[{ label: "Refresh model list", systemImage: "arrow.clockwise", onPress: () => void refresh() }]}
    />
  );
}

export function PermissionPicker({ value, inherited, onChange, disabled }: { value: PermissionMode | null; inherited?: PermissionMode; onChange: (m: PermissionMode | null) => void; disabled?: boolean }) {
  const label = value ? permissionModeLabel(value) : inherited ? `Default · ${permissionModeLabel(inherited)}` : "Default";
  const options: SelectOption<PermissionMode | "">[] = [
    ...(inherited ? [{ value: "" as const, label: `Default (${permissionModeLabel(inherited)})` }] : []),
    ...PERMISSION_MODES.map((m) => ({ value: m, label: permissionModeLabel(m), subtitle: PERMISSION_MODE_LABELS[m].description })),
  ];
  return <Select value={value ?? ""} options={options} label={label} title="Permission mode" accessibilityName="Permission mode" onChange={(v) => onChange(v || null)} disabled={disabled} />;
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
