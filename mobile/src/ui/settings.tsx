// iOS inset-grouped settings rows.
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from "react-native";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";
import { Icon } from "./Icon";

export function Group({ title, footer, children, right }: { title?: string; footer?: ReactNode; children: ReactNode; right?: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      {(title || right) && (
        <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16 }}>
          <Text style={{ flex: 1, color: c.text3, fontSize: 13, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.3 }}>{title}</Text>
          {right}
        </View>
      )}
      <View style={{ backgroundColor: c.bgElev, borderRadius: 12, overflow: "hidden", borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>{children}</View>
      {footer ? typeof footer === "string" ? <Text style={{ color: c.text3, fontSize: 13, paddingHorizontal: 16, lineHeight: 18 }}>{footer}</Text> : footer : null}
    </View>
  );
}

export function SRow({ title, sub, children, onPress, chevron, last, danger, stacked }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; onPress?: () => void; chevron?: boolean; last?: boolean; danger?: boolean; stacked?: boolean }) {
  const c = useColors();
  const content = (
    <View style={[styles.row, { borderBottomColor: c.border, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth }, stacked && { flexDirection: "column", alignItems: "stretch" }]}>
      <View style={{ flex: stacked ? undefined : 1, gap: 2 }}>
        {typeof title === "string" ? <Text style={{ color: danger ? c.red : c.text, fontSize: 16 }}>{title}</Text> : title}
        {sub ? typeof sub === "string" ? <Text style={{ color: c.text3, fontSize: 13, lineHeight: 18 }}>{sub}</Text> : sub : null}
      </View>
      {children && <View style={stacked ? { marginTop: 8 } : { alignItems: "flex-end", flexShrink: 1, maxWidth: "62%" }}>{children}</View>}
      {chevron && <Icon name="chevronRight" size={15} color={c.text3} />}
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => ({ backgroundColor: pressed ? c.bgHover : "transparent" })}>
      {content}
    </Pressable>
  ) : (
    content
  );
}

export function SSwitch({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const c = useColors();
  return <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: c.accent }} />;
}

/** Text field with a local draft committed on blur / return. */
export function DraftField({ value, onCommit, mono, ...rest }: { value: string; onCommit: (v: string) => void; mono?: boolean } & Omit<TextInputProps, "value" | "onChangeText">) {
  const c = useColors();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <TextInput
      {...rest}
      value={draft}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      returnKeyType="done"
      placeholderTextColor={c.text3}
      style={[{ color: c.text, fontSize: 16, fontFamily: mono ? MONO : undefined, textAlign: "right", minWidth: 120, paddingVertical: 4 }, rest.style]}
    />
  );
}

export function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: c.text2, fontSize: 13, fontWeight: "600" }}>{label}</Text>
      {children}
      {hint && <Text style={{ color: c.text3, fontSize: 12.5 }}>{hint}</Text>}
    </View>
  );
}

export function useInputStyle() {
  const c = useColors();
  return { borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 } as const;
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 50 },
});
