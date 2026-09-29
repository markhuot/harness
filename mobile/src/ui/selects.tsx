// The desktop's <select>s as native iOS pull-down menus: a SwiftUI Menu whose label shows the
// current value with the ⌃⌄ select glyph. Each option is a Toggle, which a menu draws as a
// checkmark item; `isOn` comes from `value` alone, so the menu never shows a choice the parent
// refused (a disabled driver, a failed save). Actions sit in their own section. Option lists come
// from the shared helpers.

import { useEffect, useSyncExternalStore } from "react";
import { View } from "react-native";
import { Button as SButton, Host, HStack, Image, Menu, ProgressView, Section, Text as SText, Toggle } from "@expo/ui/swift-ui";
import { accessibilityLabel, controlSize, disabled as disabledMod, font, foregroundStyle, lineLimit } from "@expo/ui/swift-ui/modifiers";
import { PERMISSION_MODE_LABELS, PERMISSION_MODES, type PermissionMode, type TriageChoice } from "@harness/shared";
import { decodeChoice, driverModelChoices, encodeChoice, modelCacheFor, modelName, modelOptions, permissionModeLabel } from "@harness/shared/state";
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

/** A titled group of options in a sectioned Select (no title → the options show without a heading). */
export interface SelectSection<V extends string = string> {
  title?: string;
  options: SelectOption<V>[];
}

/**
 * A native select. `label` overrides the trigger text (defaults to the selected option's label);
 * `title` heads the option list; `actions` go in their own section below the options. `sections`
 * replaces the single option list with several headed groups (`options` is then ignored).
 */
export function Select<V extends string>({
  value,
  options,
  sections,
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
  options?: SelectOption<V>[];
  sections?: SelectSection<V>[];
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
  const groups = (sections ?? [{ title, options: options ?? [] }]).filter((g) => g.options.length > 0);
  const text = label ?? selectedLabel(groups.flatMap((g) => g.options), value, placeholder);
  const tint = disabled ? c.text3 : c.accent;
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
          {groups.map((g, i) => (
            <Section key={`${i}:${g.title ?? ""}`} title={g.title}>
              {g.options.map((o) => (
                <Toggle
                  key={o.value}
                  isOn={o.value === value}
                  label={o.subtitle ? undefined : o.label}
                  modifiers={[disabledMod(!!o.disabled)]}
                  onIsOnChange={(on) => {
                    if (!on || o.disabled || o.value === value) return;
                    haptic("select");
                    onChange(o.value);
                  }}
                >
                  {o.subtitle ? [<SText key="t">{o.label}</SText>, <SText key="s">{o.subtitle}</SText>] : undefined}
                </Toggle>
              ))}
            </Section>
          ))}
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

/**
 * The combined driver + model select (watchers): Default first, then each signed-in driver's
 * models under a heading with its name, or one flat list when only one driver shows. Loads the
 * model list of every driver it may show; `resolved` is what Default falls back to.
 */
export function DriverModelPicker({
  value,
  resolved,
  onChange,
  defaultLabel,
  title = "Model",
  disabled,
}: {
  value: TriageChoice;
  resolved: TriageChoice;
  onChange: (c: TriageChoice) => void;
  defaultLabel?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { state, client, epoch } = useStore();
  const cache = modelCacheFor(client);
  // Re-render on any cache change; the lists themselves are read with cache.get below.
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const ids = [...new Set([...state.drivers.filter((d) => d.available && d.authenticated).map((d) => d.id), value.driver, resolved.driver].filter((id): id is string => !!id))];
  const key = ids.join(",");
  useEffect(() => {
    cache.syncEpoch(epoch);
    for (const id of ids) void cache.load(id);
  }, [cache, key, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const lists = ids.map((id) => ({ id, ...cache.get(id) }));
  const choices = driverModelChoices(state.drivers, Object.fromEntries(lists.map((l) => [l.id, l.data?.models])), value, resolved, { defaultLabel });
  const failed = lists.find((l) => l.error ?? l.data?.error);
  const problem = failed ? `Couldn't list ${state.drivers.find((d) => d.id === failed.id)?.name ?? failed.id} models: ${failed.error ?? failed.data?.error}` : null;
  return (
    <Select
      value={encodeChoice(value)}
      sections={[{ title, options: [choices.default] }, ...choices.groups.map((g) => ({ title: g.label ?? undefined, options: g.options }))]}
      label={choices.selectedLabel}
      onChange={(v) => onChange(decodeChoice(v))}
      title={title}
      accessibilityName={title}
      disabled={disabled}
      loading={lists.some((l) => l.loading && !l.data)}
      problem={problem}
      actions={[{ label: "Refresh model lists", systemImage: "arrow.clockwise", onPress: () => ids.forEach((id) => void cache.load(id, true)) }]}
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
