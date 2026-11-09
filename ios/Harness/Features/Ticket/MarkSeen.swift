import HarnessKit
import SwiftUI

/// Marks the ticket seen while its detail has focus (DESIGN.md "Seen and unseen"): the front sheet
/// (`sheetFront`) of an active scene. A sheet behind another, a minimized one, a card's preview and
/// the app in the background don't count.
struct MarkSeen: ViewModifier {
    let ticket: Ticket?
    @Environment(BoardStore.self) private var store
    @Environment(\.sheetFront) private var sheetFront
    @Environment(\.scenePhase) private var scenePhase

    private struct FocusKey: Equatable {
        let key: String?
        let focused: Bool
    }

    func body(content: Content) -> some View {
        let focused = sheetFront && scenePhase == .active
        let latest = SeenRules.latestNonHuman(ticket.flatMap { store.state.activity[$0.sessionId] })
        content
            .onChange(of: FocusKey(key: ticket?.key, focused: focused), initial: true) { _, now in
                if SeenRules.markOnFocus(focused: now.focused, ticket: ticket) { markSeen() }
            }
            .onChange(of: latest) { previous, latest in
                if SeenRules.markOnActivity(focused: focused, previous: previous, latest: latest) { markSeen() }
            }
    }

    private func markSeen() {
        guard let key = ticket?.key, let api = store.api else { return }
        Task { try? await api.setSeen(key, true) }
    }
}

extension View {
    func markSeen(_ ticket: Ticket?) -> some View { modifier(MarkSeen(ticket: ticket)) }
}
