// Agent markdown with native <Text>: blocks and inline tokens come from the shared parser
// (@harness/shared/state "markdown"); links open in Safari. Nothing is ever interpreted as markup.

import { Fragment } from "react";
import { Linking, ScrollView, StyleSheet, Text, View, type StyleProp, type TextStyle } from "react-native";
import { inlineTokens, parseBlocks, type InlineToken } from "@harness/shared/state";
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
          case "hr":
            return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 4 }} />;
        }
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  code: { borderRadius: 8, borderWidth: StyleSheet.hairlineWidth },
});
