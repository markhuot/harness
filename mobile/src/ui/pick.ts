// Native action sheets for a short list of actions (selects are ui/selects.tsx), and a confirm.
import { ActionSheetIOS, Alert } from "react-native";

export interface Choice<V> {
  value: V;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
}

/** Show an action sheet; resolves to the chosen value, or undefined when cancelled. */
export function pick<V>(opts: { title?: string; message?: string; choices: Choice<V>[]; cancelLabel?: string }): Promise<V | undefined> {
  const usable = opts.choices;
  const labels = usable.map((c) => c.label);
  return new Promise((resolve) => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: opts.title,
        message: opts.message,
        options: [...labels, opts.cancelLabel ?? "Cancel"],
        cancelButtonIndex: labels.length,
        destructiveButtonIndex: usable.map((c, i) => (c.destructive ? i : -1)).filter((i) => i >= 0),
        disabledButtonIndices: usable.map((c, i) => (c.disabled ? i : -1)).filter((i) => i >= 0),
      },
      (i) => resolve(i < usable.length ? usable[i]!.value : undefined),
    );
  });
}

export function confirm(title: string, message: string, action: string, destructive = true): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: action, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ]),
  );
}
