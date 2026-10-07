import HarnessKit
import SwiftUI

/// The iPhone's ticket sheet (`Router.ticketSheet` / `Router.dock`): a system sheet with two
/// detents. At `.large` it's the ticket (or New session) in its own NavigationStack, so a child,
/// dep or parent pushes inside the sheet and Back returns. Dragging it down to the dock detent
/// docks it, like Mail's minimized draft: the stack stays mounted (drafts, scroll, path) but
/// hidden, and a bar with the ticket's key sits under the board, which stays usable
/// (`presentationBackgroundInteraction`). Tapping the bar brings it back up; dragging it below the
/// dock detent swipes it away. The system sheet does the drags, so the content's own gestures (the
/// pager, the back swipe, the Browser tab, the transcript) keep theirs.
///
/// Projects, pickers and covers come up over it (they're presented from here while it's up, since
/// the root is busy presenting this).
struct TicketSheetHost: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// The sheet as it was last up, so its content stays while it animates away.
    @State private var last: TicketSheet?

    var body: some View {
        let current = router.ticketSheet ?? router.dock
        let sheet = current ?? last
        GeometryReader { geo in
            // By height rather than state, so the bar takes over as the sheet settles at the dock.
            let docked = geo.size.height < TicketDock.height + 60
            ZStack(alignment: .top) {
                if let sheet {
                    stack(sheet)
                        .opacity(docked ? 0 : 1)
                        .allowsHitTesting(!docked)
                        .accessibilityHidden(docked)
                    if docked {
                        TicketDock(sheet: sheet) { router.restoreDock() }
                            .frame(height: geo.size.height)
                    }
                }
            }
            .onChange(of: docked) { _, docked in
                // A docked New session mustn't keep the keyboard up over the board.
                if docked { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
            }
        }
        .onChange(of: current, initial: true) { _, s in if let s { last = s } }
        .presentationDetents([TicketDock.detent, .large], selection: detent)
        .presentationBackgroundInteraction(.enabled(upThrough: TicketDock.detent))
        .presentationDragIndicator(.visible)
        .sheet(item: Binding(get: { router.sheet }, set: { router.sheet = $0 })) { sheet in
            SheetHost(sheet: sheet)
                .fullScreenCover(item: coverBinding(whenSheet: true)) { CoverHost(cover: $0) }
        }
        .fullScreenCover(item: coverBinding(whenSheet: false)) { CoverHost(cover: $0) }
        .toastOverlay()
    }

    /// The store wraps the whole stack: pushed screens take their environment from the stack.
    private func stack(_ sheet: TicketSheet) -> some View {
        RequireStore {
            NavigationStack(path: Binding(get: { (router.ticketSheet ?? router.dock)?.path ?? [] },
                                          set: { router.setTicketSheetPath($0) })) {
                root(sheet.root)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(c.bg)
                    .navigationDestination(for: Route.self) { RouteScreen(route: $0) }
            }
        }
        // New session that became its ticket starts over as the ticket's screen.
        .id(sheet.root)
    }

    @ViewBuilder private func root(_ root: TicketSheet.Root) -> some View {
        switch root {
        case let .ticket(key, tab): RouteScreen(route: .ticket(key: key, tab: tab))
        case let .newSession(projectId, key): NewSessionScreen(projectId: projectId, key: key)
        }
    }

    private var detent: Binding<PresentationDetent> {
        Binding(get: { router.dock != nil ? TicketDock.detent : .large },
                set: { $0 == TicketDock.detent ? router.dockSheet() : router.restoreDock() })
    }

    /// The cover is presented by whichever level is on top: a sheet over this one, else this.
    private func coverBinding(whenSheet: Bool) -> Binding<CoverRoute?> {
        Binding(get: { (router.sheet != nil) == whenSheet ? router.cover : nil }, set: { router.cover = $0 })
    }
}

/// Keeps a section's screen clear of the docked ticket sheet. It goes inside the section's
/// NavigationStack, on each screen: a safe-area inset outside the stack doesn't reach the board's
/// own bottom bar.
private struct DockClearance: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen

    func body(content: Content) -> some View {
        content.safeAreaInset(edge: .bottom, spacing: 0) {
            if router.dock != nil {
                Color.clear.frame(height: TicketDock.clearance(homeIndicator: screen?.homeIndicator ?? 0))
            }
        }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}

/// The docked ticket sheet's bar: the ticket on top's key (or "New session"); a tap opens it again.
struct TicketDock: View {
    let sheet: TicketSheet
    let open: () -> Void
    @Environment(\.palette) private var c

    /// The sheet's height while docked.
    static let height: CGFloat = 64
    static let detent = PresentationDetent.height(height)

    /// What a section gives up at its bottom while a sheet is docked, so the dock sits under the
    /// board's bottom bar rather than over it: the docked sheet, which floats a little above the
    /// screen's edge, less the home indicator's inset the section already keeps clear, plus a gap.
    static func clearance(homeIndicator: CGFloat) -> CGFloat {
        max(0, height + 27 - homeIndicator)
    }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: sheet.topTicketKey == nil ? "square.and.pencil" : "rectangle.stack")
                    .foregroundStyle(c.accent)
                Text(sheet.title)
                    .font(.headline)
                    .foregroundStyle(c.text)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Image(systemName: "chevron.up")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text3)
            }
            .padding(.horizontal, 22)
            .padding(.top, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(sheet.title), docked")
        .accessibilityHint("Double-tap to open")
        .accessibilityIdentifier("ticket-dock")
    }
}
