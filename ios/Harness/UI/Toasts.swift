import HarnessKit
import SwiftUI

/// Toasts below the status bar: at most 3, newest last; errors stay 6 s, info
/// 2.6 s; a tap dismisses one. Post with `@Environment(ToastCenter.self)` → `toasts.show(…)`.
@MainActor
@Observable
final class ToastCenter {
    enum Kind: Sendable { case error, info }

    struct Toast: Identifiable, Equatable {
        let id: Int
        let message: String
        let kind: Kind
    }

    static let maxShown = 3
    private(set) var toasts: [Toast] = []
    @ObservationIgnored private var next = 1

    func show(_ message: String, kind: Kind = .error) {
        let id = next
        next += 1
        toasts = Array(toasts.suffix(Self.maxShown - 1)) + [Toast(id: id, message: message, kind: kind)]
        let delay: Duration = kind == .error ? .seconds(6) : .milliseconds(2600)
        Task { [weak self] in
            try? await Task.sleep(for: delay)
            self?.dismiss(id)
        }
    }

    func dismiss(_ id: Int) {
        toasts.removeAll { $0.id == id }
    }
}

/// Draws ToastCenter's toasts over the content, at the top of the safe area.
struct ToastOverlay: ViewModifier {
    @Environment(ToastCenter.self) private var center
    @Environment(\.palette) private var c

    func body(content: Content) -> some View {
        content.overlay(alignment: .top) {
            VStack(spacing: 8) {
                ForEach(center.toasts) { t in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Icon(t.kind == .error ? "alert" : "checkCircle", size: 16, weight: .semibold)
                            .foregroundStyle(t.kind == .error ? c.red : c.green)
                        Text(t.message)
                            .font(.scaled(size: 14.5))
                            .foregroundStyle(c.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(12)
                    .background(c.bgElev, in: .rect(cornerRadius: 14))
                    .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(t.kind == .error ? c.red : c.border, lineWidth: 1))
                    .shadow(color: .black.opacity(0.18), radius: 8, y: 6)
                    .onTapGesture { withAnimation { center.dismiss(t.id) } }
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(.isStaticText)
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.top, 6)
            .animation(.snappy, value: center.toasts)
        }
    }
}

extension View {
    func toastOverlay() -> some View { modifier(ToastOverlay()) }
}
