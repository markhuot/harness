import UIKit

/// The RN app's haptic vocabulary (ui/haptics.ts): tap = light impact, heavy = medium impact,
/// select = selection change, success/warning/error = notifications.
enum Haptic: Sendable {
    case tap, heavy, select, success, warning, error

    @MainActor
    func play() {
        switch self {
        case .tap: UIImpactFeedbackGenerator(style: .light).impactOccurred()
        case .heavy: UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .select: UISelectionFeedbackGenerator().selectionChanged()
        case .success: UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .warning: UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case .error: UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
    }
}

/// `haptic("success")`.
@MainActor
func haptic(_ kind: Haptic = .tap) { kind.play() }
