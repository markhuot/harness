// Native header bar items (UIBarButtonItem / UIMenu) with SF Symbols, loosely typed.
import type { NativeStackHeaderItem, NativeStackHeaderItemMenuAction } from "expo-router";

type SFIcon = { type: "sfSymbol"; name: never };
export const sf = (name: string) => ({ type: "sfSymbol", name }) as unknown as SFIcon;

export function action(label: string, icon: string, onPress: () => void, extra: Partial<Omit<NativeStackHeaderItemMenuAction, "type" | "label" | "icon" | "onPress">> = {}): NativeStackHeaderItemMenuAction {
  return { type: "action", label, icon: sf(icon), onPress, ...extra };
}

export function menuItem(label: string, icon: string, items: NativeStackHeaderItemMenuAction[]): NativeStackHeaderItem {
  return { type: "menu", label, icon: sf(icon), menu: { items } };
}

export function buttonItem(label: string, icon: string, onPress: () => void, extra: { tintColor?: string; variant?: "plain" | "done" | "prominent"; disabled?: boolean } = {}): NativeStackHeaderItem {
  return { type: "button", label, icon: sf(icon), onPress, ...extra };
}
