// Agent markdown with native <Text>: blocks and inline tokens come from the shared parser
// (@harness/shared/state "markdown"); links open in Safari, ticket keys open the ticket, and wide
// tables scroll sideways.
// Nothing is ever interpreted as markup.

import { Fragment, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { useRouter } from "expo-router";
import { inlineTokens, parseBlocks, ticketLinkable, type Block, type InlineToken } from "@harness/shared/state";
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";

function Inline({ tokens, base }: { tokens: InlineToken[]; base: StyleProp<TextStyle> }) {
  const c = useColors();
  const { state } = useStore();
  const router = useRouter();
  return (
    <>
      {tokens.map((t, i) => {
        switch (t.t) {
          case "text":
            return <Fragment key={i}>{t.text}</Fragment>;
          case "ticket":
            // A key the store can resolve (or in a project's key space) opens that ticket; look-alikes stay text.
            return ticketLinkable(state, t.key) ? (
              <Text key={i} style={{ color: c.accentText }} accessibilityRole="link" onPress={() => router.push({ pathname: "/ticket/[key]", params: { key: t.key } })}>
                {t.key}
              </Text>
            ) : (
              <Fragment key={i}>{t.key}</Fragment>
            );
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

/**
 * Whether `text` has a block that scrolls sideways (a table or fenced code). Such markdown needs a
 * container with a definite width: in a shrink-to-fit one (alignItems: "flex-end" with a maxWidth)
 * Yoga measures the scroll content almost zero wide, and the block lays out thousands of points tall.
 */
export const scrollsSideways = (text: string) => parseBlocks(text).some((b) => b.t === "table" || b.t === "code");

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
                    {/* flexShrink, not flex: 1. A zero flex-basis collapses the text to nothing
                        inside a shrink-wrapped parent such as the user's reply bubble. */}
                    <Text style={[base, { flexShrink: 1 }]} selectable>
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
          case "table":
            return <Table key={i} block={b} size={size} color={base.color as string} />;
          case "hr":
            return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 4 }} />;
        }
      })}
    </View>
  );
}

const MAX_COL = 240;

/** React Native has no table layout. A hidden copy of each column lays out unconstrained inside the
 *  horizontal ScrollView and reports its natural width; the visible rows then use those widths
 *  (capped, so one long cell wraps instead of stretching the table) and line up row by row. */
function Table({ block, size, color }: { block: Extract<Block, { t: "table" }>; size: number; color: string }) {
  const c = useColors();
  const [widths, setWidths] = useState<(number | undefined)[]>([]);
  const fontSize = size - 1.5;
  const cellText: TextStyle = { fontSize, lineHeight: Math.round(fontSize * 1.4), color };
  const cellBox = { paddingHorizontal: 8, paddingVertical: 5 };
  const text = (cell: string, head: boolean, j: number) => (
    <Text style={[cellText, head && { fontWeight: "700" }, { textAlign: block.align[j] ?? "left" }]} selectable={widths.length > 0}>
      <Inline tokens={inlineTokens(cell)} base={cellText} />
    </Text>
  );
  const row = (cells: string[], head: boolean, key: number, last: boolean) => (
    <View key={key} style={{ flexDirection: "row", backgroundColor: head ? c.bgSunken : undefined, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderColor: c.border }}>
      {cells.map((cell, j) => (
        <View key={j} style={[cellBox, { width: widths[j] ?? MAX_COL, borderLeftWidth: j ? StyleSheet.hairlineWidth : 0, borderColor: c.border }]}>
          {text(cell, head, j)}
        </View>
      ))}
    </View>
  );
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.measure} pointerEvents="none" aria-hidden>
        {block.header.map((h, j) => (
          <View
            key={j}
            style={{ alignSelf: "flex-start" }}
            onLayout={(e) => {
              const w = Math.min(MAX_COL, Math.ceil(e.nativeEvent.layout.width) + 1);
              setWidths((prev) => (prev[j] === w ? prev : Object.assign([...prev], { [j]: w })));
            }}
          >
            {[h, ...block.rows.map((r) => r[j] ?? "")].map((cell, k) => (
              <View key={k} style={cellBox}>
                {text(cell, k === 0, j)}
              </View>
            ))}
          </View>
        ))}
      </View>
      <View style={[styles.table, { borderColor: c.border, opacity: widths.filter(Boolean).length === block.header.length ? 1 : 0 }]}>
        {row(block.header, true, -1, !block.rows.length)}
        {block.rows.map((r, k) => row(r, false, k, k === block.rows.length - 1))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  code: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
  table: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  // Wide enough that no hidden column is ever squeezed; absolute, so it never sizes the scroll content.
  measure: { position: "absolute", width: 10000, opacity: 0, flexDirection: "row", alignItems: "flex-start" },
});
