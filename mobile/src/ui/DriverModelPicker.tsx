// The combined driver + model picker (watchers, the Triage default, New session). A SwiftUI Menu
// can't search, so the trigger looks like the other selects (label in the accent colour plus the
// ⌃⌄ glyph) but opens a page sheet: a type-ahead field over a virtualised list with Default first,
// then each signed-in driver's models under a sticky heading (one flat list when only one driver
// shows). Option lists and filtering come from the shared helpers; lib/modelSheet builds the rows.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Modal, Pressable, SectionList, StyleSheet, Text, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { TriageChoice } from "@harness/shared";
import { decodeChoice, driverModelChoices, encodeChoice, modelCacheFor, type ChoiceOptions } from "@harness/shared/state";
import { choiceSections } from "../lib/modelSheet";
import { useTheme } from "../state/app";
import { useStore } from "../state/store";
import { Button } from "./kit";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

/**
 * Model lists for every driver the picker may show (installed and signed in, plus the picked and
 * the resolved driver), through the shared cache. Re-renders on any cache change.
 */
function useChoiceModels(value: TriageChoice, resolved: TriageChoice) {
  const { state, client, epoch } = useStore();
  const cache = modelCacheFor(client);
  useSyncExternalStore(cache.subscribe, () => cache.version);
  const ids = [...new Set([...state.drivers.filter((d) => d.available && d.authenticated).map((d) => d.id), value.driver, resolved.driver].filter((id): id is string => !!id))];
  const key = ids.join(",");
  useEffect(() => {
    cache.syncEpoch(epoch);
    for (const id of ids) void cache.load(id);
  }, [cache, key, epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const lists = ids.map((id) => ({ id, ...cache.get(id) }));
  const name = (id: string) => state.drivers.find((d) => d.id === id)?.name ?? id;
  const failed = lists.find((l) => l.error ?? l.data?.error);
  return {
    drivers: state.drivers,
    models: Object.fromEntries(lists.map((l) => [l.id, l.data?.models])),
    loading: lists.some((l) => l.loading && !l.data),
    problem: failed ? `Couldn't list ${name(failed.id)} models: ${failed.error ?? failed.data?.error}` : null,
    refresh: () => ids.forEach((id) => void cache.load(id, true)),
  };
}

export function DriverModelPicker({
  value,
  resolved,
  onChange,
  defaultLabel,
  title = "Model",
  disabled,
}: {
  value: TriageChoice;
  /** What Default falls back to (driver + model) */
  resolved: TriageChoice;
  onChange: (c: TriageChoice) => void;
  defaultLabel?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const lists = useChoiceModels(value, resolved);
  const choices = driverModelChoices(lists.drivers, lists.models, value, resolved, { defaultLabel });
  const tint = disabled ? c.text3 : c.accent;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${choices.selectedLabel}`}
        style={({ pressed }) => ({ maxWidth: 280, flexDirection: "row", alignItems: "center", gap: 4, opacity: disabled ? 0.6 : pressed ? 0.5 : 1 })}
      >
        <Text numberOfLines={1} style={{ color: tint, fontSize: 15, flexShrink: 1 }}>
          {choices.selectedLabel}
        </Text>
        {lists.loading ? (
          <ActivityIndicator size="small" style={{ transform: [{ scale: 0.7 }] }} />
        ) : lists.problem ? (
          <SymbolView name="exclamationmark.triangle.fill" size={12} tintColor={c.amber} />
        ) : (
          <SymbolView name="chevron.up.chevron.down" size={11} tintColor={tint} />
        )}
      </Pressable>
      {open && (
        <ModelSheet
          title={title}
          choices={choices}
          picked={encodeChoice(value)}
          loading={lists.loading}
          problem={lists.problem}
          driverNames={Object.fromEntries(lists.drivers.map((d) => [d.id, d.name]))}
          onRefresh={lists.refresh}
          onClose={() => setOpen(false)}
          onPick={(v) => {
            haptic("select");
            setOpen(false);
            if (v !== encodeChoice(value)) onChange(decodeChoice(v));
          }}
        />
      )}
    </>
  );
}

function ModelSheet({
  title,
  choices,
  picked,
  loading,
  problem,
  driverNames,
  onRefresh,
  onClose,
  onPick,
}: {
  title: string;
  choices: ChoiceOptions;
  picked: string;
  loading: boolean;
  problem: string | null;
  driverNames: Record<string, string>;
  onRefresh: () => void;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  const { c, resolved } = useTheme();
  const [query, setQuery] = useState("");
  const sections = useMemo(() => choiceSections(choices, query, driverNames), [choices, query, driverNames]);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10 }}>
          <Button title="Cancel" variant="ghost" onPress={onClose} hapticKind={null} />
          <Text style={{ flex: 1, textAlign: "center", color: c.text, fontWeight: "600", fontSize: 16 }}>{title}</Text>
          <Pressable onPress={onRefresh} hitSlop={10} accessibilityRole="button" accessibilityLabel="Refresh model lists" style={{ width: 64, alignItems: "flex-end" }}>
            {loading ? <ActivityIndicator size="small" /> : <Icon name="refresh" size={17} color={c.accent} />}
          </Pressable>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search models"
            placeholderTextColor={c.text3}
            clearButtonMode="while-editing"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            keyboardAppearance={resolved}
            accessibilityLabel="Search models"
            style={{ backgroundColor: c.bgElev, color: c.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16 }}
          />
          {problem && <Text style={{ color: c.amber, fontSize: 13 }}>{problem}</Text>}
        </View>
        <SectionList
          sections={sections}
          keyExtractor={(o) => o.value || "default"}
          stickySectionHeadersEnabled
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ paddingBottom: 40 }}
          renderSectionHeader={({ section }) =>
            section.title ? (
              <Text style={{ backgroundColor: c.bg, color: c.text3, fontSize: 13, fontWeight: "600", textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 18, paddingBottom: 6 }}>{section.title}</Text>
            ) : (
              <View style={{ height: 12 }} />
            )
          }
          renderItem={({ item, index, section }) => {
            const on = item.value === picked;
            return (
              <Pressable
                onPress={() => onPick(item.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={section.title ? `${section.title}, ${item.label}` : item.label}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 16,
                  paddingVertical: 13,
                  backgroundColor: pressed ? c.bgHover : c.bgElev,
                  borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: c.border,
                })}
              >
                <Text style={{ flex: 1, color: c.text, fontSize: 16 }} numberOfLines={2}>
                  {item.label}
                </Text>
                {on && <Icon name="check" size={17} color={c.accent} strokeWidth={2.25} />}
              </Pressable>
            );
          }}
          ListEmptyComponent={<Text style={{ color: c.text3, fontSize: 15, textAlign: "center", paddingTop: 40 }}>No models match</Text>}
        />
      </View>
    </Modal>
  );
}
