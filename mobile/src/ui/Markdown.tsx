// Agent markdown with native <Text>: blocks and inline tokens come from the shared parser
// (@harness/shared/state "markdown"); links open in Safari, and tables scroll sideways when wide. Nothing is ever interpreted as markup.

import { Fragment } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { inlineTokens, parseBlocks, plainText, type InlineToken } from "@harness/shared/state";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";

function Inline({ tokens, base }: { tokens: InlineToken[]; base: StyleProp<TextStyle> }) {
  const c = useColors();
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.t) {
          case "text":
            return <Fragment key={i}>{t.text}</Fragment>;
          case "code":
            return (
              <Text key={i} style={{ fontFamily: MONO, fontSize: 13, backgroundColor: c.bgActive, color: c.text }}>
                {` ${t.text} `}
              </Text>
            );
          case "strong":
            return (
              <Text key={i} style={{ fontWeight: "700" }}>
                {t.text}
              </Text>
            );
          case "em":
            return (
              <Text key={i} style={{ fontStyle: "italic" }}>
                {t.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} style={{ color: c.accentText }} accessibilityRole="link" onPress={() => void Linking.openURL(t.url)}>
                {t.text}
              </Text>
            );
        }
      })}
    </>
  );
}

export function Markdown({ text, size = 15, color }: { text: string; size?: number; color?: string }) {
  const c = useColors();
  const base: TextStyle = { fontSize: size, lineHeight: Math.round(size * 1.45), color: color ?? c.text };
  const blocks = parseBlocks(text);
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case "p":
            return (
              <Text key={i} style={base} selectable>
                <Inline tokens={inlineTokens(b.text)} base={base} />
              </Text>
            );
          case "h":
            return (
              <Text key={i} style={[base, { fontWeight: "700", fontSize: b.level <= 2 ? size + 2 : size + 0.5, marginTop: 2 }]} selectable>
                <Inline tokens={inlineTokens(b.text)} base={base} />
              </Text>
            );
          case "ul":
          case "ol":
            return (
              <View key={i} style={{ gap: 4 }}>
                {b.items.map((it, j) => (
                  <View key={j} style={{ flexDirection: "row", gap: 8, paddingRight: 4 }}>
                    <Text style={[base, { color: c.text3, minWidth: b.t === "ol" ? 18 : 10, textAlign: "right" }]}>{b.t === "ol" ? `${j + 1}.` : "•"}</Text>
                    <Text style={[base, { flex: 1 }]} selectable>
                      <Inline tokens={inlineTokens(it)} base={base} />
                    </Text>
                  </View>
                ))}
              </View>
            );
          case "code":
            return (
              <ScrollView key={i} horizontal style={[styles.code, { backgroundColor: c.bgSunken, borderColor: c.border }]} contentContainerStyle={{ padding: 10 }}>
                <Text style={{ fontFamily: MONO, fontSize: 12.5, lineHeight: 18, color: c.text }} selectable>
                  {b.text}
                </Text>
              </ScrollView>
            );
          case "quote":
            return (
              <View key={i} style={{ borderLeftWidth: 3, borderLeftColor: c.borderStrong, paddingLeft: 10 }}>
                <Text style={[base, { color: c.text2 }]} selectable>
                  <Inline tokens={inlineTokens(b.text)} base={base} />
                </Text>
              </View>
            );
          case "table": {
            const cellText: TextStyle = { fontSize: size - 1.5, lineHeight: Math.round((size - 1.5) * 1.4), color: base.color };
            const widths = columnWidths(b.header, b.rows, size - 1.5);
            const row = (cells: string[], head: boolean, key: number, last: boolean) => (
              <View key={key} style={{ flexDirection: "row", backgroundColor: head ? c.bgSunken : undefined, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderColor: c.border }}>
                {cells.map((cell, j) => (
                  <View key={j} style={{ width: widths[j], paddingHorizontal: 8, paddingVertical: 5, borderLeftWidth: j ? StyleSheet.hairlineWidth : 0, borderColor: c.border }}>
                    <Text style={[cellText, head && { fontWeight: "700" }, { textAlign: b.align[j] ?? "left" }]} selectable>
                      <Inline tokens={inlineTokens(cell)} base={cellText} />
                    </Text>
                  </View>
                ))}
              </View>
            );
            return (
              <ScrollView key={i} horizontal showsHorizontalScrollIndicator={false}>
                <View style={[styles.table, { borderColor: c.border }]}>
                  {row(b.header, true, -1, !b.rows.length)}
                  {b.rows.map((r, k) => row(r, false, k, k === b.rows.length - 1))}
                </View>
              </ScrollView>
            );
          }
          case "hr":
            return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 4 }} />;
        }
      })}
    </View>
  );
}

/** React Native has no table layout, so each column gets a width from its longest cell (clamped, so
 *  a long cell wraps instead of stretching the table) and every row lays out against those widths. */
function columnWidths(header: string[], rows: string[][], fontSize: number): number[] {
  return header.map((_, j) => {
    const chars = Math.max(...[header, ...rows].map((r) => plainText(r[j] ?? "").length));
    return Math.min(240, Math.max(56, Math.ceil(chars * fontSize * 0.56) + 18));
  });
}

const styles = StyleSheet.create({
  code: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  table: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
});
