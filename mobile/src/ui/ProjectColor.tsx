// Project color picker for project settings: Default (the theme accent), the eleven presets,
// and Custom, which opens a hue × shade grid (like the Grid tab of the system color picker)
// with a hex field for an exact value.

import { useEffect, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { normalizeProjectColor, PROJECT_COLORS } from "@harness/shared";
import { useColors } from "../state/app";
import { MONO } from "../theme/tokens";
import { useInputStyle } from "./settings";
import { haptic } from "./haptics";

const HUES = [0, 30, 45, 60, 90, 140, 170, 190, 210, 235, 270, 310];
const LIGHTNESS = [82, 68, 55, 45, 35, 25];

function hslHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Rows of the custom grid: one per shade across every hue, then a gray ramp. */
export const CUSTOM_GRID: string[][] = [
  ...LIGHTNESS.map((l) => HUES.map((h) => hslHex(h, 80, l))),
  HUES.map((_, i) => hslHex(0, 0, Math.round(92 - (i * 84) / (HUES.length - 1)))),
];

function Swatch({ fill, selected, label, onPress, size = 30, children }: { fill: string; selected: boolean; label: string; onPress: () => void; size?: number; children?: React.ReactNode }) {
  const c = useColors();
  return (
    <Pressable
      onPress={() => {
        haptic("select");
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      hitSlop={4}
      style={{ width: size + 6, height: size + 6, borderRadius: (size + 6) / 2, borderWidth: 2, borderColor: selected ? c.text : "transparent", alignItems: "center", justifyContent: "center" }}
    >
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: fill, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>{children}</View>
    </Pressable>
  );
}

export function ProjectColorPicker({ value, onChange }: { value: string | null; onChange: (color: string | null) => void }) {
  const c = useColors();
  const inputStyle = useInputStyle();
  const current = normalizeProjectColor(value) ?? null;
  const custom = current !== null && current.startsWith("#");
  const [open, setOpen] = useState(custom);
  const [hex, setHex] = useState(custom ? current : "");
  useEffect(() => setHex(custom ? current : ""), [custom, current]);
  const commitHex = () => {
    const n = normalizeProjectColor(hex.startsWith("#") ? hex : `#${hex}`);
    if (n && n.startsWith("#")) {
      if (n !== current) onChange(n);
    } else setHex(custom ? current : "");
  };

  return (
    <View style={{ gap: 12 }} accessibilityRole="radiogroup" accessibilityLabel="Project color">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
        <Swatch fill={c.accentSoft} selected={current === null} label="Default" onPress={() => (setOpen(false), onChange(null))}>
          <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: c.accentText }} />
        </Swatch>
        {PROJECT_COLORS.map((p) => (
          <Swatch key={p.id} fill={p.hex} selected={current === p.id} label={p.name} onPress={() => (setOpen(false), onChange(p.id))} />
        ))}
        <Swatch fill={custom ? current : c.bgActive} selected={custom || open} label="Custom" onPress={() => setOpen(true)}>
          {!custom && <Text style={{ color: c.text2, fontSize: 16, fontWeight: "600" }}>+</Text>}
        </Swatch>
      </View>
      {open && (
        <View style={{ gap: 10 }}>
          <View style={{ borderRadius: 8, overflow: "hidden" }} accessibilityLabel="Custom colors">
            {CUSTOM_GRID.map((row, r) => (
              <View key={r} style={{ flexDirection: "row" }}>
                {row.map((fill) => (
                  <Pressable
                    key={fill}
                    onPress={() => {
                      haptic("select");
                      onChange(fill);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: current === fill }}
                    accessibilityLabel={`Custom ${fill}`}
                    style={{ flex: 1, aspectRatio: 1, backgroundColor: fill, borderWidth: current === fill ? 2 : 0, borderColor: c.text }}
                  />
                ))}
              </View>
            ))}
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ color: c.text2, fontSize: 14 }}>Hex</Text>
            <TextInput
              style={[inputStyle, { flex: 1, fontFamily: MONO, fontSize: 14, paddingVertical: 8 }]}
              value={hex}
              onChangeText={setHex}
              onBlur={commitHex}
              onSubmitEditing={commitHex}
              placeholder="#5e6ad2"
              placeholderTextColor={c.text3}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={7}
              returnKeyType="done"
              accessibilityLabel="Custom color hex"
            />
          </View>
        </View>
      )}
    </View>
  );
}
