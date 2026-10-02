import HarnessKit
import SwiftUI

/// The RN kit's button variants (ui/kit.tsx Button).
enum ButtonVariant: Sendable {
    case primary, secondary, ghost, danger, dangerSolid
}

/// `.buttonStyle(.harness(.primary))`: the kit's filled/outlined/ghost buttons. Disabled dims to
/// 0.45, pressed to 0.7. `small` is the compact 32 pt height.
struct HarnessButtonStyle: ButtonStyle {
    var variant: ButtonVariant = .secondary
    var small = false
    var fullWidth = true

    @Environment(\.palette) private var c
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        let (bg, fg, border): (Color, Color, Color) = switch variant {
        case .primary: (c.accent, c.onAccent, c.accent)
        case .secondary: (c.bgElev, c.text, c.border)
        case .ghost: (.clear, c.text2, .clear)
        case .danger: (.clear, c.red, .clear)
        case .dangerSolid: (c.redSolid, c.onDanger, c.redSolid)
        }
        configuration.label
            .font(.scaled(size: small ? 14 : 15, weight: .semibold))
            .lineLimit(1)
            .foregroundStyle(fg)
            .padding(.horizontal, small ? 10 : 14)
            .frame(minHeight: small ? 32 : 40)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(bg, in: .rect(cornerRadius: small ? 8 : 10))
            .overlay(RoundedRectangle(cornerRadius: small ? 8 : 10).strokeBorder(border, lineWidth: 1 / 3))
            .opacity(!enabled ? 0.45 : configuration.isPressed ? 0.7 : 1)
            .contentShape(.rect)
    }
}

extension ButtonStyle where Self == HarnessButtonStyle {
    static func harness(_ variant: ButtonVariant = .secondary, small: Bool = false, fullWidth: Bool = true) -> HarnessButtonStyle {
        HarnessButtonStyle(variant: variant, small: small, fullWidth: fullWidth)
    }
}

/// The kit Button: title and/or icon, a spinner while `loading` (and disabled meanwhile), and a
/// haptic on tap (`haptic: nil` for none). The accessibility label is the title unless given.
struct HButton: View {
    var title: String?
    var icon: String?
    var variant: ButtonVariant = .secondary
    var small = false
    var loading = false
    var fullWidth = true
    var haptic: Haptic? = .tap
    var accessibilityLabel: String?
    let action: () -> Void

    init(_ title: String? = nil, icon: String? = nil, variant: ButtonVariant = .secondary, small: Bool = false, loading: Bool = false,
         fullWidth: Bool = true, haptic: Haptic? = .tap, accessibilityLabel: String? = nil, action: @escaping () -> Void) {
        self.title = title
        self.icon = icon
        self.variant = variant
        self.small = small
        self.loading = loading
        self.fullWidth = fullWidth
        self.haptic = haptic
        self.accessibilityLabel = accessibilityLabel
        self.action = action
    }

    var body: some View {
        Button {
            haptic?.play()
            action()
        } label: {
            HStack(spacing: 6) {
                if loading {
                    ProgressView().controlSize(.small).tint(.primary)
                } else if let icon {
                    Icon(icon, size: small ? 13 : 15, weight: .semibold)
                }
                if let title { Text(title) }
            }
        }
        .buttonStyle(.harness(variant, small: small, fullWidth: fullWidth))
        .disabled(loading)
        .accessibilityLabel(accessibilityLabel ?? title ?? "")
    }
}

extension View {
    /// A primary toolbar button (ui/header.ts primaryItemStyle). The system draws a prominent
    /// item's glyph in white on the tint, so only themes whose onAccent is white get one; the
    /// rest (Dracula, Catppuccin, Nord…) get a plain item tinted with the accent, which keeps the
    /// glyph readable.
    @ViewBuilder func primaryToolbarItem(_ c: Palette) -> some View {
        if c.tokens[.onAccent].lowercased() == "#ffffff" {
            buttonStyle(.borderedProminent).tint(c.accent)
        } else {
            tint(c.accent)
        }
    }
}
