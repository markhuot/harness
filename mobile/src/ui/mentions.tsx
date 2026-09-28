// @-mention autocomplete for a TextInput (shared/src/mentions.ts): typing `@fo` lists matching
// files and folders, and tapping one completes it. Picking a folder keeps the list open inside it.
// The service attaches the mentioned files to the agent's prompt.
//
//   const m = useFileMentions(text, setText, search);
//   <TextInput value={text} onChangeText={setText} {...m.inputProps} />
//   <MentionList mentions={m} />
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { activeMention, insertMention, type FileMatch } from "@harness/shared";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

const DEBOUNCE_MS = 80;

export interface FileMentions {
  matches: FileMatch[];
  pick: (m: FileMatch) => void;
  inputProps: {
    selection?: { start: number; end: number };
    onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  };
}

/** `search` must be stable (useCallback): a new one re-runs the lookup. */
export function useFileMentions(value: string, setValue: (v: string) => void, search: (query: string) => Promise<FileMatch[]>): FileMentions {
  const [caret, setCaret] = useState<number | null>(null);
  // Set after a pick so the caret lands after the mention; released on the next selection change.
  const [forced, setForced] = useState<number | null>(null);
  const [matches, setMatches] = useState<FileMatch[]>([]);
  const mention = caret === null || caret > value.length ? null : activeMention(value, caret);
  const query = mention?.query ?? null;

  useEffect(() => {
    if (query === null) {
      setMatches([]);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      search(query).then(
        (m) => live && setMatches(m),
        () => live && setMatches([]),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, search]);

  return {
    matches: mention ? matches : [],
    pick: (m) => {
      if (!mention) return;
      haptic("select");
      const next = insertMention(value, mention, m.path);
      setValue(next.text);
      setCaret(next.caret);
      setForced(next.caret);
    },
    inputProps: {
      selection: forced === null ? undefined : { start: forced, end: forced },
      onSelectionChange: (e) => {
        const { start, end } = e.nativeEvent.selection;
        setCaret(start === end ? start : null);
        if (forced !== null && start === forced) setForced(null);
      },
    },
  };
}

/** The matching files, one tappable row each; nothing when there's no mention or no match. */
export function MentionList({ mentions, maxHeight = 220 }: { mentions: FileMentions; maxHeight?: number }) {
  const c = useColors();
  if (!mentions.matches.length) return null;
  return (
    <View style={{ maxHeight, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.bgElev, overflow: "hidden" }} accessibilityLabel="Files">
      <ScrollView keyboardShouldPersistTaps="always">
        {mentions.matches.map((m, i) => {
          const trimmed = m.path.replace(/\/$/, "");
          const slash = trimmed.lastIndexOf("/");
          const name = trimmed.slice(slash + 1) + (m.kind === "dir" ? "/" : "");
          const dir = slash === -1 ? "" : trimmed.slice(0, slash + 1);
          return (
            <Pressable
              key={m.path}
              accessibilityRole="button"
              accessibilityLabel={m.path}
              onPress={() => mentions.pick(m)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingHorizontal: 12,
                paddingVertical: 10,
                backgroundColor: pressed ? c.bgActive : "transparent",
                borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
                borderTopColor: c.border,
              })}
            >
              <Icon name={m.kind === "dir" ? "folder" : "fileText"} size={15} color={c.text3} />
              <Text style={{ color: c.text, fontFamily: MONO, fontSize: 14 }} numberOfLines={1}>
                {name}
              </Text>
              {!!dir && (
                <Text style={{ flex: 1, color: c.text3, fontSize: 12.5 }} numberOfLines={1} ellipsizeMode="head">
                  {dir}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
