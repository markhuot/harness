// The branch picker (New session, ticket Details). Same trigger as the other selects (label in the
// accent colour plus the ⌃⌄ glyph); it opens a page sheet with a search field over the project's
// branches (GET /projects/:id/branches?q=, debounced), "New branch harness/<key>" first and a
// "Create <name>" row for a name that doesn't exist yet. Rows come from the shared branchOptions.

import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SymbolView } from "expo-symbols";
import type { BranchInfo } from "@harness/shared";
import { branchOptions, relativeTime, tildify, type BranchOption } from "@harness/shared/state";
import { useTheme } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Button } from "./kit";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

const DEBOUNCE_MS = 150;

/** The project's branches matching `query`, re-fetched (debounced) as it changes while `active`. */
function useBranchSearch(projectId: string, query: string, active: boolean) {
  const { client, epoch } = useStore();
  const [matches, setMatches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !projectId) return;
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
  }, [client, projectId, query, active, epoch]);
  return { matches, loading, error };
}

export function BranchPicker({
  projectId,
  value,
  defaultName,
  onChange,
  title = "Branch",
  disabled,
}: {
  projectId: string;
  /** The picked branch; null → the default new branch */
  value: string | null;
  /** harness/<key> for the ticket */
  defaultName: string;
  /** The picked row's branch comes along so the caller can hint at checkedOutAt */
  onChange: (value: string | null, branch: BranchInfo | null) => void;
  title?: string;
  disabled?: boolean;
}) {
  const { c } = useTheme();
  const [open, setOpen] = useState(false);
  const tint = disabled ? c.text3 : c.accent;
  const label = value ?? `New branch ${defaultName}`;
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
          defaultName={defaultName}
          onClose={() => setOpen(false)}
          onPick={(row) => {
            haptic("select");
            setOpen(false);
            if (row.value !== value) onChange(row.value, row.branch ?? null);
          }}
        />
      )}
    </>
  );
}

function BranchSheet({ title, projectId, picked, defaultName, onClose, onPick }: { title: string; projectId: string; picked: string | null; defaultName: string; onClose: () => void; onPick: (row: BranchOption) => void }) {
  const { c, resolved } = useTheme();
  const [query, setQuery] = useState("");
  const { matches, loading, error } = useBranchSearch(projectId, query, true);
  const rows = useMemo(() => branchOptions(query, defaultName, matches), [query, defaultName, matches]);
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
            onSubmitEditing={() => rows[0] && onPick(rows[0])}
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
            const on = item.value === picked;
            const where = item.branch?.checkedOutAt;
            return (
              <Pressable
                onPress={() => onPick(item)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={where ? `${item.label}, checked out in ${tildify(where)}` : item.label}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingHorizontal: 16,
                  paddingVertical: 12,
                  backgroundColor: pressed ? c.bgHover : c.bgElev,
                  borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: c.border,
                })}
              >
                <Icon name={item.kind === "existing" ? "branch" : "plus"} size={15} color={item.kind === "existing" ? c.text3 : c.accent} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={{ color: item.kind === "existing" ? c.text : c.accentText, fontSize: 15, fontFamily: MONO }} numberOfLines={1}>
                    {item.label}
                  </Text>
                  {item.branch ? (
                    <Text style={{ color: where ? c.amber : c.text3, fontSize: 12.5 }} numberOfLines={1}>
                      {where ? `Checked out in ${tildify(where)}` : `Last commit ${relativeTime(item.branch.lastCommitAt)}`}
                    </Text>
                  ) : (
                    <Text style={{ color: c.text3, fontSize: 12.5 }}>Created from the base branch</Text>
                  )}
                </View>
                {on && <Icon name="check" size={17} color={c.accent} strokeWidth={2.25} />}
              </Pressable>
            );
          }}
          ListEmptyComponent={loading ? null : <Text style={{ color: c.text3, fontSize: 15, textAlign: "center", paddingTop: 40 }}>{query.trim() ? "No branches match, and that isn't a valid branch name" : "No branches"}</Text>}
        />
      </View>
    </Modal>
  );
}
