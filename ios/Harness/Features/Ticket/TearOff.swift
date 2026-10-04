import HarnessKit
import SwiftUI

// Tearing a ticket's tabs, browser tabs and composer off into windows of their own (iPad,
// ARCHITECTURE.md § Windows). Each one drags out of its window (TicketWindowDrag) and has Open in
// New Window in its context menu; once it's torn off, its place in the ticket shows Return to this
// window, which closes the pinned window and shows it here again. Only where the app can open
// windows and the window is regular width (`canTearOff`): never on iPhone or at compact width.

extension EnvironmentValues {
    /// This window can tear things off into windows of their own: multiple windows, regular width.
    @Entry var canTearOff = false
}

extension View {
    /// Makes the view a drag source for `value`'s window, with Open in New Window and (once torn
    /// off) Return to this window in its context menu. `onReturn` shows the torn-off thing here
    /// again after its window closes. Nothing at all when the window can't tear off.
    func tearOff(_ value: TicketWindowValue, tornOff: Bool, onReturn: @escaping () -> Void = {}) -> some View {
        modifier(TearOffSource(value: value, tornOff: tornOff, onReturn: onReturn))
    }

    /// Only the drag, for a view whose context menu already lists `TearOffMenuItems` (a board card).
    func tearOffDrag(_ value: TicketWindowValue) -> some View { modifier(TearOffDrag(value: value)) }
}

private struct TearOffSource: ViewModifier {
    let value: TicketWindowValue
    let tornOff: Bool
    let onReturn: () -> Void

    @Environment(\.canTearOff) private var canTearOff

    func body(content: Content) -> some View {
        if canTearOff {
            content
                .onDrag { TicketWindowDrag.provider(value) }
                .contextMenu { TearOffMenuItems(value: value, tornOff: tornOff, onReturn: onReturn) }
        } else {
            content
        }
    }
}

private struct TearOffDrag: ViewModifier {
    let value: TicketWindowValue
    @Environment(\.canTearOff) private var canTearOff

    func body(content: Content) -> some View {
        if canTearOff {
            content.onDrag { TicketWindowDrag.provider(value) }
        } else {
            content
        }
    }
}

/// Open in New Window, or Return to this window once `value`'s window is open.
struct TearOffMenuItems: View {
    let value: TicketWindowValue
    let tornOff: Bool
    var onReturn: () -> Void = {}

    var body: some View {
        if tornOff {
            Button("Return to this window", systemImage: "arrow.down.right.and.arrow.up.left") {
                TearOff.returnHere(value, then: onReturn)
            }
            Button("Show its window", systemImage: "macwindow") { WindowDirectory.shared.openTicket(value, from: nil) }
        } else {
            Button("Open in New Window", systemImage: "macwindow.badge.plus") { WindowDirectory.shared.openTicket(value, from: nil) }
        }
    }
}

enum TearOff {
    /// Closes `value`'s pinned window and shows it here again (`then`).
    @MainActor static func returnHere(_ value: TicketWindowValue, then: () -> Void) {
        haptic(.tap)
        WindowDirectory.shared.close(value)
        then()
    }
}

/// In a torn-off tab's place: what it is, that it's in another window, and Return to this window.
struct TornOffPlaceholder: View {
    let value: TicketWindowValue
    let name: String
    var onReturn: () -> Void = {}

    @Environment(\.palette) private var c

    var body: some View {
        EmptyState(title: "\(name) is in another window", message: "It's open in a window of its own.", systemImage: "macwindow") {
            Button("Return to this window") { TearOff.returnHere(value, then: onReturn) }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("tornOff.return")
            Button("Show its window") { WindowDirectory.shared.openTicket(value, from: nil) }
                .buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
    }
}

/// Where the composer was, once it's torn off: one line with Return to this window.
struct ComposerReturnBar: View {
    let value: TicketWindowValue

    @Environment(\.palette) private var c

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "macwindow").foregroundStyle(c.text3)
            Text("The message box is in another window")
                .font(.scaled(size: 13.5))
                .foregroundStyle(c.text2)
                .lineLimit(1)
            Spacer(minLength: 4)
            Button("Return to this window") { TearOff.returnHere(value) {} }
                .font(.scaled(size: 13.5, weight: .semibold))
                .buttonStyle(.glass)
                .accessibilityIdentifier("tornOff.composer.return")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }
}

/// The composer's grip (iPad, regular width): a small handle over the field that drags the
/// composer out into a window of its own, and opens one from its context menu.
struct ComposerGrip: View {
    let ticketKey: String

    @Environment(\.canTearOff) private var canTearOff
    @Environment(\.palette) private var c

    var body: some View {
        if canTearOff {
            Capsule()
                .fill(c.text3.opacity(0.6))
                .frame(width: 36, height: 5)
                .frame(width: 88, height: 16)
                .contentShape(.rect)
                .tearOff(.pinned(ticketKey, TicketWindowValue.composer), tornOff: false)
                .accessibilityLabel("Message box")
                .accessibilityHint("Drag out of the window, or touch and hold, to open it in a window of its own.")
                .accessibilityAction(named: "Open in New Window") {
                    WindowDirectory.shared.openTicket(.pinned(ticketKey, TicketWindowValue.composer), from: nil)
                }
        }
    }
}
