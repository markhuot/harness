import * as Haptics from "expo-haptics";

export type HapticKind = "tap" | "select" | "success" | "warning" | "error" | "heavy";

export function haptic(kind: HapticKind = "tap") {
  const run = () => {
    switch (kind) {
      case "tap":
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      case "heavy":
        return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      case "select":
        return Haptics.selectionAsync();
      case "success":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      case "warning":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      case "error":
        return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };
  void run()?.catch(() => {});
}
