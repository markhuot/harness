import HarnessKit
import SwiftUI

/// The iPhone's ticket sheet (`Router.ticketSheet` / `Router.dock`): a system sheet with two
/// detents. At `.large` it's the ticket (or New session) in its own NavigationStack, so a child,
/// dep or parent pushes inside the sheet and Back returns. Dragged down to the dock detent it
/// docks, like Mail's minimized draft: the stack stays mounted (drafts, scroll, path) but hidden,
/// and the small sheet shows the ticket's key (TicketDock) under the board, which stays usable
/// (`presentationBackgroundInteraction`). Tapping it, or dragging it up, brings it back; swiping it
/// down sends it away. The system does the drags, the inset and the corners, so the content's own
/// gestures (the pager, the back swipe, the Browser tab, the transcript) keep theirs; the board's
/// bottom bar takes the docked sheet's side inset (DockedSheetInset) so the two line up.
///
/// Pickers, the watcher form and covers come up over it: the root is busy presenting this, so
/// they're presented from here. Projects closes it instead (`Router.open(.sheet(.projects))`), and
/// anything the board behind presents (an alert in Settings, say) has UIKit dismiss it, which the
/// root's binding turns into `dismissSheet()`. New session drafts are saved either way.
struct TicketSheetHost: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// The sheet as it was last up, so its content stays while it animates away.
    @State private var last: TicketSheet?
    @Environment(DockedSheetInset.self) private var dockInset

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
                        TicketDock(sheet: sheet, open: { router.restoreDock() }, close: { router.dismissSheet() })
                            .frame(height: geo.size.height)
                    }
                }
            }
            // Behind the keyboard too, so its rounded corners show the sheet's background, not the
            // system sheet's. Docked, the sheet keeps the system's glass.
            .background { if !docked { c.bg.ignoresSafeArea() } }
            .onChange(of: docked) { _, docked in
                // A docked New session mustn't keep the keyboard up over the board.
                if docked { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
            }
            // Where the system floats the docked sheet, for the sections and the board's bar.
            .onGeometryChange(for: CGRect?.self) { g in docked ? g.frame(in: .global) : nil } action: { f in
                if let f { dockInset.sides = f.minX; dockInset.top = f.minY }
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
        // The sheet runs to the screen's bottom edge without keeping the home indicator's inset, so
        // the composer measures its concentric gap from the edge itself.
        .environment(\.concentricBottomGap, 0)
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

/// Where the system floats the docked ticket sheet, as last measured docked: how far from the
/// screen's sides, and its top edge in the window. The sheet is presented, so this reaches the
/// sections (DockClearance) and the board's bottom bar through the environment (RootView) rather
/// than a preference; the bar lines up with the dock while `Router.showsDock`.
@Observable final class DockedSheetInset {
    var sides: CGFloat?
    var top: CGFloat?
}

/// Keeps a section's screen clear of the docked ticket sheet. It goes inside the section's
/// NavigationStack, on each screen: a safe-area inset outside the stack doesn't reach the board's
/// own bottom bar. Not while a keyboard is up: the dock is behind it.
private struct DockClearance: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?
    @State private var keyboard = false

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if router.showsDock && !keyboard {
                    Color.clear.frame(height: TicketDock.clearance(screen: screen, dockTop: dockInset?.top))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}

/// The docked ticket sheet's content: the ticket on top's key (or "New session"); a tap opens it
/// again, and the close button at its end sends it away without opening it.
struct TicketDock: View {
    let sheet: TicketSheet
    let open: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var c

    /// The sheet's height while docked.
    static let height: CGFloat = 64
    static let detent = PresentationDetent.height(height)

    /// What a section gives up at its bottom while a sheet is docked, so the dock sits under the
    /// board's bottom bar rather than over it: everything below the docked sheet's top edge, less
    /// the home indicator's inset the section already keeps clear. The bar keeps its own gap above
    /// that (BoardScreen). Before the dock is measured, the sheet and the float the system gives it.
    static func clearance(screen: ConcentricBar.Screen?, dockTop: CGFloat?) -> CGFloat {
        let homeIndicator = screen?.homeIndicator ?? 0
        guard let screen, let dockTop else { return max(0, height + 16 - homeIndicator) }
        return max(0, screen.height - dockTop - homeIndicator)
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
            }
            .padding(.leading, 22)
            .padding(.trailing, 22 + Self.closeSize)
            .padding(.top, 6)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(sheet.title), docked")
        .accessibilityHint("Double-tap to open")
        .accessibilityIdentifier("ticket-dock")
        .accessibilityAction(named: "Close", close)
        // Over the open button rather than in it, so the dock still spans the sheet's width.
        .overlay(alignment: .trailing) {
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(c.text3)
                    .frame(width: Self.closeSize, height: Self.closeSize)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 12)
            .padding(.top, 6)
            .accessibilityLabel("Close \(sheet.title)")
            .accessibilityIdentifier("ticket-dock-close")
        }
    }

    /// The close button's tap target.
    private static let closeSize: CGFloat = 44
}
