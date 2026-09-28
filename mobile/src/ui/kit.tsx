// Presentational building blocks in the desktop's design language (badges, chips, pills, cards),
// sized for touch and Dynamic Type.

import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type TextProps, type TextStyle, type ViewStyle } from "react-native";
import type { ReviewState, Ticket, TicketStatus } from "@harness/shared";
import { driverIcon, driverLabel, STATUS_LABEL } from "@harness/shared/state";
import { projectKeyColors } from "@harness/shared/themes";
import { useColors } from "../state/app";
import { CLAUDE_ORANGE, MONO, RADIUS, type Palette } from "../theme/tokens";
import { Icon, type IconName } from "./Icon";
import { haptic } from "./haptics";

export type Tone = "neutral" | "accent" | "green" | "red" | "amber" | "violet";

export function toneColors(c: Palette, tone: Tone): { bg: string; fg: string } {
  switch (tone) {
    case "accent":
      return { bg: c.accentSoft, fg: c.accentText };
    case "green":
      return { bg: c.greenSoft, fg: c.green };
    case "red":
      return { bg: c.redSoft, fg: c.red };
    case "amber":
      return { bg: c.amberSoft, fg: c.amber };
    case "violet":
      return { bg: c.violetSoft, fg: c.violet };
    default:
      return { bg: c.bgActive, fg: c.text2 };
  }
}

/** Text in the app's colors; `tone` picks text / text-2 / text-3. */
export function T({ tone = 1, mono, style, ...rest }: TextProps & { tone?: 1 | 2 | 3; mono?: boolean }) {
  const c = useColors();
  return <Text {...rest} style={[{ color: tone === 1 ? c.text : tone === 2 ? c.text2 : c.text3, fontSize: 15 }, mono && { fontFamily: MONO }, style]} />;
}

export function Badge({ tone = "neutral", outline, icon, iconColor, children, style }: { tone?: Tone; outline?: boolean; icon?: IconName; iconColor?: string; children?: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  const t = toneColors(c, tone);
  return (
    <View style={[s.badge, { backgroundColor: outline ? "transparent" : t.bg, borderColor: outline ? c.border : "transparent" }, style]}>
      {icon && <Icon name={icon} size={11} color={iconColor ?? t.fg} strokeWidth={2} />}
      {children !== undefined && children !== null && (
        <Text style={[s.badgeText, { color: t.fg }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>
          {children}
        </Text>
      )}
    </View>
  );
}

export function StatusDot({ status, size = 8 }: { status: TicketStatus; size?: number }) {
  const c = useColors();
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: c[status] }} />;
}

export function StatusPill({ status }: { status: TicketStatus }) {
  const c = useColors();
  return (
    <View style={[s.pill, { borderColor: c.border, backgroundColor: c.bgElev }]}>
      <StatusDot status={status} />
      <Text style={[s.pillText, { color: c.text2 }]} maxFontSizeMultiplier={1.4}>
        {STATUS_LABEL[status]}
      </Text>
    </View>
  );
}

/** The project's key badge ("HAR") in the project's color (null → the theme accent). */
export function ProjectKey({ k, color, size = "md" }: { k: string; color: string | null; size?: "sm" | "md" | "lg" }) {
  const c = useColors();
  const { bg, fg } = projectKeyColors(color, c);
  const dims = size === "sm" ? { h: 16, fs: 9, w: 24 } : size === "lg" ? { h: 24, fs: 11, w: 34 } : { h: 19, fs: 10, w: 28 };
  return (
    <View style={{ minWidth: dims.w, height: dims.h, borderRadius: 4, paddingHorizontal: 3, alignItems: "center", justifyContent: "center", backgroundColor: bg }}>
      <Text style={{ fontSize: dims.fs, fontWeight: "700", letterSpacing: 0.3, color: fg }} maxFontSizeMultiplier={1.3}>
        {k.slice(0, 3)}
      </Text>
    </View>
  );
}

export function ReviewMark({ who, state }: { who: "agent" | "human"; state: ReviewState }) {
  const c = useColors();
  const tone: Tone = state === "approved" ? "green" : state === "changes_requested" ? "red" : "neutral";
  const t = toneColors(c, tone);
  return (
    <View style={[s.badge, { backgroundColor: t.bg, gap: 3 }]} accessibilityLabel={`${who === "agent" ? "Agent" : "Human"} review: ${state.replace("_", " ")}`}>
      <Icon name={who === "agent" ? "bot" : "user"} size={11} color={t.fg} strokeWidth={2} />
      {state === "approved" ? (
        <Icon name="check" size={11} color={t.fg} strokeWidth={2.75} />
      ) : state === "changes_requested" ? (
        <Icon name="x" size={11} color={t.fg} strokeWidth={2.75} />
      ) : (
        <View style={{ width: 6, height: 6, borderRadius: 3, borderWidth: 1.5, borderColor: t.fg, opacity: 0.7 }} />
      )}
    </View>
  );
}

export function DriverBadge({ driver }: { driver: string }) {
  return (
    <Badge outline icon={driverIcon(driver)} iconColor={driver === "claude-code" ? CLAUDE_ORANGE : undefined}>
      {driverLabel(driver)}
    </Badge>
  );
}

export function KindBadge({ ticket, childCount }: { ticket: Ticket; childCount?: number }) {
  if (ticket.kind !== "conductor") return null;
  return (
    <Badge tone="violet" icon="conductor">
      {`Conductor${childCount ? ` · ${childCount}` : ""}`}
    </Badge>
  );
}

/**
 * A dependency chip. `unknown` = the ticket isn't loaded yet (done tickets page in, so it's most
 * likely an older done one): neutral, never "waiting", until it resolves.
 */
export function Chip({ label, done, onPress, prefix, unknown }: { label: string; done: boolean; onPress?: () => void; prefix?: string; unknown?: boolean }) {
  const c = useColors();
  const body = (
    <View style={[s.chip, { borderColor: done ? c.greenSoft : c.borderStrong, borderStyle: done || unknown ? "solid" : "dashed", opacity: done ? 1 : 0.75 }]}>
      {!unknown && <Icon name={done ? "check" : "clock"} size={9} color={done ? c.green : c.text2} strokeWidth={done ? 3 : 2} />}
      {prefix && !unknown && <Text style={[s.chipText, { color: c.text3, fontFamily: undefined }]}>{prefix}</Text>}
      <Text style={[s.chipText, { color: done ? c.green : c.text2 }]} maxFontSizeMultiplier={1.4}>
        {label}
      </Text>
    </View>
  );
  return onPress ? (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="link">
      {body}
    </Pressable>
  ) : (
    body
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSolid";

export function Button({
  title,
  icon,
  onPress,
  variant = "secondary",
  disabled,
  loading,
  small,
  style,
  hapticKind = "tap",
  accessibilityLabel,
}: {
  title?: string;
  icon?: IconName;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
  hapticKind?: Parameters<typeof haptic>[0] | null;
  accessibilityLabel?: string;
}) {
  const c = useColors();
  const colors = {
    primary: { bg: c.accent, fg: c.onAccent, border: c.accent },
    secondary: { bg: c.bgElev, fg: c.text, border: c.border },
    ghost: { bg: "transparent", fg: c.text2, border: "transparent" },
    danger: { bg: "transparent", fg: c.red, border: "transparent" },
    dangerSolid: { bg: c.redSolid, fg: c.onDanger, border: c.redSolid },
  }[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!disabled || !!loading }}
      disabled={disabled || loading}
      onPress={() => {
        if (hapticKind) haptic(hapticKind);
        onPress();
      }}
      style={({ pressed }) => [
        s.btn,
        small && s.btnSm,
        { backgroundColor: colors.bg, borderColor: colors.border, opacity: disabled ? 0.45 : pressed ? 0.7 : 1 },
        !title && { paddingHorizontal: small ? 7 : 10 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator size="small" color={colors.fg} /> : icon ? <Icon name={icon} size={small ? 13 : 15} color={colors.fg} strokeWidth={2} /> : null}
      {title ? (
        <Text style={[s.btnText, small && { fontSize: 14 }, { color: colors.fg }]} numberOfLines={1} maxFontSizeMultiplier={1.5}>
          {title}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return <View style={[{ backgroundColor: c.bgElev, borderRadius: RADIUS.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, overflow: "hidden" }, style]}>{children}</View>;
}

export function SectionTitle({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  const c = useColors();
  return <Text style={[{ fontSize: 12.5, fontWeight: "600", color: c.text3, textTransform: "uppercase", letterSpacing: 0.4 }, style]}>{children}</Text>;
}

export function Empty({ icon, title, children, action }: { icon?: IconName; title?: string; children?: ReactNode; action?: ReactNode }) {
  const c = useColors();
  return (
    <View style={s.empty}>
      {icon && <Icon name={icon} size={26} color={c.text3} strokeWidth={1.5} />}
      {title && <Text style={{ color: c.text, fontWeight: "600", fontSize: 16, textAlign: "center" }}>{title}</Text>}
      {children ? <Text style={{ color: c.text3, fontSize: 14, textAlign: "center", lineHeight: 20 }}>{children}</Text> : null}
      {action}
    </View>
  );
}

export function Callout({ tone, icon, title, children, right }: { tone: Tone; icon: IconName; title?: string; children?: ReactNode; right?: ReactNode }) {
  const c = useColors();
  const t = toneColors(c, tone);
  return (
    <View style={[s.callout, { backgroundColor: t.bg, borderColor: t.bg }]}>
      <Icon name={icon} size={16} color={t.fg} strokeWidth={2} />
      <View style={{ flex: 1, gap: 2 }}>
        {title && <Text style={{ color: t.fg, fontWeight: "600", fontSize: 14 }}>{title}</Text>}
        {typeof children === "string" ? (
          <Text style={{ color: c.text, fontSize: 14, lineHeight: 20 }} selectable>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
      {right}
    </View>
  );
}

/** iOS-style segmented control. */
export function Segmented<V extends string>({ value, options, onChange, style }: { value: V; options: { value: V; label: string }[]; onChange: (v: V) => void; style?: StyleProp<ViewStyle> }) {
  const c = useColors();
  return (
    <View style={[s.seg, { backgroundColor: c.bgActive }, style]} accessibilityRole="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (!on) haptic("select");
              onChange(o.value);
            }}
            style={[s.segItem, on && { backgroundColor: c.bgElev, shadowColor: "#000", shadowOpacity: 0.08, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } }]}
          >
            <Text style={{ fontSize: 13.5, fontWeight: on ? "600" : "500", color: on ? c.text : c.text2 }} numberOfLines={1} maxFontSizeMultiplier={1.4}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Spinner({ color, size = "small" }: { color?: string; size?: "small" | "large" }) {
  const c = useColors();
  return <ActivityIndicator size={size} color={color ?? c.text3} />;
}

/** Re-render periodically so relative timestamps stay fresh. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

const s = StyleSheet.create({
  badge: { flexDirection: "row", alignItems: "center", gap: 4, height: 21, paddingHorizontal: 7, borderRadius: 5, borderWidth: StyleSheet.hairlineWidth },
  badgeText: { fontSize: 12, fontWeight: "500" },
  pill: { flexDirection: "row", alignItems: "center", gap: 6, height: 24, paddingHorizontal: 9, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  pillText: { fontSize: 12.5, fontWeight: "500" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, height: 21, paddingHorizontal: 7, borderRadius: 11, borderWidth: 1 },
  chipText: { fontSize: 11.5, fontFamily: MONO },
  btn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minHeight: 40, paddingHorizontal: 14, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  btnSm: { minHeight: 32, paddingHorizontal: 10, borderRadius: 8 },
  btnText: { fontSize: 15, fontWeight: "600" },
  empty: { alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 36, paddingHorizontal: 24 },
  callout: { flexDirection: "row", gap: 10, alignItems: "flex-start", padding: 12, borderRadius: RADIUS.md, borderWidth: 1 },
  seg: { flexDirection: "row", padding: 2, borderRadius: 9 },
  segItem: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 6, paddingHorizontal: 8, borderRadius: 7 },
});
