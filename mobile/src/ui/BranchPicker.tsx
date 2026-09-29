// The branch picker (New session, ticket Details). Same trigger as the other selects (label in the
// accent colour plus the ⌃⌄ glyph); it opens a page sheet with a search field over the project's
// branches (GET /projects/:id/branches?q=, debounced): the default first, then the matches, then
// the typed name (a new branch, or why git won't take it). Rows come from the shared branchRows,
// the same ones the Mac's BranchSelect shows.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { BranchInfo } from "@harness/shared";
import { branchRows, relativeTime, rowId, tildify, type BranchRow } from "@harness/shared/state";
import { useTheme } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Button } from "./kit";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

const DEBOUNCE_MS = 150;

/** The project's branches matching `query`, re-fetched (debounced) as it changes. */
function useBranchSearch(projectId: string, query: string) {
  const { client, epoch } = useStore();
  const [matches, setMatches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      client.projectBranches(projectId, query.trim()).then(
        (list) => {
          if (!live) return;
          setMatches(list);
          setError(null);
          setLoading(false);
        },
        (e: unknown) => {
          if (!live) return;
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, projectId, query, epoch]);
  return { matches, loading, error };
}

export function BranchPicker({
  projectId,
  value,
  defaultLabel,
  newLabel,
  onChange,
  title = "Branch",
  disabled,
}: {
  projectId: string;
  /** The picked branch; null → the default */
  value: string | null;
  /** The null pick, e.g. "New branch harness/web-4" */
  defaultLabel: string;
  /** A typed name the list doesn't have, e.g. "Create x from main" */
  newLabel: (name: string) => string;
  /** The picked row's list entry comes along so the caller can hint at checkedOutAt */
  onChange: (value: string | null, branch: BranchInfo | null) => void;
  title?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const tint = disabled ? c.text3 : c.accent;
  const label = value ?? defaultLabel;
  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        disabled={disabled}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`${title}, ${label}`}
        style={({ pressed }) => ({ maxWidth: 280, flexDirection: "row", alignItems: "center", gap: 4, opacity: disabled ? 0.6 : pressed ? 0.5 : 1 })}
      >
        <Text numberOfLines={1} style={{ color: tint, fontSize: 15, flexShrink: 1, fontFamily: value ? MONO : undefined }}>
          {label}
        </Text>
        {!disabled && <SymbolView name="chevron.up.chevron.down" size={11} tintColor={tint} />}
      </Pressable>
      {open && (
        <BranchSheet
          title={title}
          projectId={projectId}
          picked={value}
          defaultLabel={defaultLabel}
          newLabel={newLabel}
          onClose={() => setOpen(false)}
          onPick={(row) => {
            if (row.kind === "invalid") return;
            haptic("select");
            setOpen(false);
            if (row.value !== value) onChange(row.value, row.kind === "branch" ? row.info : null);
          }}
        />
      )}
    </>
  );
}

function BranchSheet({
  title,
  projectId,
  picked,
  defaultLabel,
  newLabel,
  onClose,
  onPick,
}: {
  title: string;
  projectId: string;
  picked: string | null;
  defaultLabel: string;
  newLabel: (name: string) => string;
  onClose: () => void;
  onPick: (row: BranchRow) => void;
}) {
  const { c, resolved } = useTheme();
  const [query, setQuery] = useState("");
  const { matches, loading, error } = useBranchSearch(projectId, query);
  const rows = useMemo(() => branchRows(matches, query, defaultLabel, newLabel), [matches, query, defaultLabel, newLabel]);
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={{ flexDirection: "row", alignItems: "center", padding: 14, gap: 10 }}>
          <Button title="Cancel" variant="ghost" onPress={onClose} hapticKind={null} />
          <Text style={{ flex: 1, textAlign: "center", color: c.text, fontWeight: "600", fontSize: 16 }}>{title}</Text>
          <View style={{ width: 64, alignItems: "flex-end" }}>{loading && <ActivityIndicator size="small" />}</View>
        </View>
        <View style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            autoFocus
            placeholder="Search or name a new branch"
            placeholderTextColor={c.text3}
            clearButtonMode="while-editing"
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            keyboardAppearance={resolved}
            accessibilityLabel="Search branches"
            onSubmitEditing={() => {
              const first = rows.find((r) => rowId(r) !== null);
              if (first) onPick(first);
            }}
            style={{ backgroundColor: c.bgElev, color: c.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 16, fontFamily: MONO }}
          />
          {error && <Text style={{ color: c.amber, fontSize: 13 }}>Couldn't list branches: {error}</Text>}
        </View>
        <FlatList
          data={rows}
          keyExtractor={(r) => `${r.kind}:${r.value ?? ""}`}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{ paddingTop: 12, paddingBottom: 40 }}
          renderItem={({ item, index }) => {
            const border = { borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: c.border };
            if (item.kind === "invalid")
              return (
                <View style={[{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.bgElev }, border]}>
                  <Icon name="alert" size={15} color={c.red} />
                  <Text style={{ flex: 1, color: c.red, fontSize: 14 }}>{item.label}</Text>
                </View>
              );
            const on = item.value === picked;
            const where = item.kind === "branch" ? item.info.checkedOutAt : null;
            return (
              <Pressable
                onPress={() => onPick(item)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={where ? `${item.label}, checked out in ${tildify(where)}` : item.label}
                style={({ pressed }) => [{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: pressed ? c.bgHover : c.bgElev }, border]}
              >
                <Icon name={item.kind === "branch" ? "branch" : "plus"} size={15} color={item.kind === "branch" ? c.text3 : c.accent} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: item.kind === "branch" ? c.text : c.accentText, fontSize: 15, fontFamily: MONO }} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.kind === "branch" && (
                    <Text style={{ color: where ? c.amber : c.text3, fontSize: 12.5 }} numberOfLines={1} ellipsizeMode="middle">
                      {where ? `Checked out in ${tildify(where)}` : `Last commit ${relativeTime(item.info.lastCommitAt)}`}
                    </Text>
                  )}
                </View>
                {on && <Icon name="check" size={17} color={c.accent} strokeWidth={2.25} />}
              </Pressable>
            );
          }}
          ListEmptyComponent={loading ? null : <Text style={{ color: c.text3, fontSize: 15, textAlign: "center", paddingTop: 40 }}>No branches match</Text>}
        />
      </View>
    </Modal>
  );
}
