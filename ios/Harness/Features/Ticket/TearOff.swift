import HarnessKit
import SwiftUI

// Tearing a ticket's tabs and browser tabs off into windows of their own (iPad,
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
            // EmptyState dims its whole content, actions included: the buttons set their own colors.
            Button("Return to this window") { TearOff.returnHere(value, then: onReturn) }
                .buttonStyle(.borderedProminent)
                .foregroundStyle(c.onAccent)
                .accessibilityIdentifier("tornOff.return")
            Button("Show its window") { WindowDirectory.shared.openTicket(value, from: nil) }
                .buttonStyle(.bordered)
                .foregroundStyle(c.accentText)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.bg)
    }
}
