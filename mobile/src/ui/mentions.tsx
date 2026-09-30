// @-mention autocomplete for a TextInput (shared/src/mentions.ts): typing `@fo` lists matching
// files and folders, and tapping one completes it. Picking a folder keeps the list open inside it.
// The service attaches the mentioned files to the agent's prompt. With `searchCommands`, a /command
// or skill that starts the text autocompletes the same way (shared/src/commands.ts); the agent
// expands it itself.
//
//   const m = useFileMentions(text, setText, search, searchCommands);
//   <TextInput value={text} onChangeText={setText} {...m.inputProps} />
//   <MentionList mentions={m} />
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, type NativeSyntheticEvent, type TextInputSelectionChangeEventData } from "react-native";
import { insertCommand, insertMention, type CommandMatch, type FileMatch } from "@harness/shared";
import { commandAt, mentionAt, NO_CARET, onPick, onSelection, selectionProp, type Caret } from "../lib/mentionCaret";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";
import { Icon } from "./Icon";
import { haptic } from "./haptics";

const DEBOUNCE_MS = 80;

/** One row of the list: a file or folder for an @-mention, or a command for a leading /. */
export type MentionItem = { kind: "file"; match: FileMatch } | { kind: "command"; match: CommandMatch };

export interface FileMentions {
  items: MentionItem[];
  pick: (item: MentionItem) => void;
  inputProps: {
    selection?: { start: number; end: number };
    onSelectionChange: (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => void;
  };
}

/** `search` and `searchCommands` must be stable (useCallback): a new one re-runs the lookup. */
export function useFileMentions(
  value: string,
  setValue: (v: string) => void,
  search: (query: string) => Promise<FileMatch[]>,
  searchCommands?: (query: string) => Promise<CommandMatch[]>,
): FileMentions {
  const [caret, setCaret] = useState<Caret>(NO_CARET);
  const [items, setItems] = useState<MentionItem[]>([]);
  // A command only starts the text, so while one is being typed it wins over an @ inside it.
  const command = searchCommands ? commandAt(value, caret) : null;
  const mention = command ? null : mentionAt(value, caret);
  // "/" and "@" keep the two lookups apart when the query text is the same.
  const lookup = command ? `/${command.query}` : mention ? `@${mention.query}` : null;

  useEffect(() => {
    if (lookup === null) {
      setItems([]);
      return;
    }
    let live = true;
    const q = lookup.slice(1);
    const timer = setTimeout(() => {
      const found: Promise<MentionItem[]> =
        lookup[0] === "/" && searchCommands
          ? searchCommands(q).then((m) => m.map((match) => ({ kind: "command", match })))
          : search(q).then((m) => m.map((match) => ({ kind: "file", match })));
      found.then(
        (m) => live && setItems(m),
        () => live && setItems([]),
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [lookup, search, searchCommands]);

  return {
    items: command || mention ? items : [],
    pick: (item) => {
      let next;
      if (item.kind === "command" && command) next = insertCommand(value, command, item.match.name);
      else if (item.kind === "file" && mention) next = insertMention(value, mention, item.match.path);
      else return;
      haptic("select");
      setValue(next.text);
      setCaret(onPick(next.caret));
    },
    inputProps: {
      selection: selectionProp(caret),
      onSelectionChange: (e) => {
        const { start, end } = e.nativeEvent.selection;
        setCaret((c) => onSelection(c, start, end));
      },
    },
  };
}

/** The matching files or commands, one tappable row each; nothing when there's no mention or no match. */
export function MentionList({ mentions, maxHeight = 220 }: { mentions: FileMentions; maxHeight?: number }) {
  const c = useColors();
  if (!mentions.items.length) return null;
  const commands = mentions.items[0]!.kind === "command";
  return (
    <View
      style={{ maxHeight, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, backgroundColor: c.bgElev, overflow: "hidden" }}
      accessibilityLabel={commands ? "Commands" : "Files"}
    >
      <ScrollView keyboardShouldPersistTaps="always">
        {mentions.items.map((item, i) => {
          let icon: "folder" | "fileText" | "zap", name: string, detail: string, label: string;
          if (item.kind === "command") {
            icon = "zap";
            name = `/${item.match.name}`;
            detail = item.match.description;
            label = name;
          } else {
            const trimmed = item.match.path.replace(/\/$/, "");
            const slash = trimmed.lastIndexOf("/");
            icon = item.match.kind === "dir" ? "folder" : "fileText";
            name = trimmed.slice(slash + 1) + (item.match.kind === "dir" ? "/" : "");
            detail = slash === -1 ? "" : trimmed.slice(0, slash + 1);
            label = item.match.path;
          }
          return (
            <Pressable
              key={`${item.kind}:${label}`}
              accessibilityRole="button"
              accessibilityLabel={label}
              onPress={() => mentions.pick(item)}
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
              <Icon name={icon} size={15} color={c.text3} />
              <Text style={{ color: c.text, fontFamily: MONO, fontSize: 14, flexShrink: 0 }} numberOfLines={1}>
                {name}
              </Text>
              {!!detail && (
                <Text style={{ flex: 1, color: c.text3, fontSize: 12.5 }} numberOfLines={1} ellipsizeMode={item.kind === "file" ? "head" : "tail"}>
                  {detail}
                </Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}
