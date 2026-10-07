import HarnessKit
import SwiftUI

/// The iPhone's ticket sheet (`Router.ticketSheet` / `Router.dock`), over the sections: the ticket
/// (or New session) in its own NavigationStack, so a child, dep or parent pushes inside the sheet
/// and Back returns. Dragged down by its header, it docks under the sections when let go part way,
/// like Mail's minimized draft, and goes when flicked off or dragged to the very bottom. Docked,
/// the bar (TicketDock) shows the ticket on top's key; a tap brings the sheet back as it was, and
/// a swipe down sends it away.
///
/// It's drawn here rather than presented as a system sheet: a sheet docked at a small detent is
/// dismissed by UIKit as soon as the screen behind it presents anything (Settings' alerts, the
/// Projects sheet). Drawn in place, the sections' alerts and the Router's sheets come up over it,
/// and the docked stack stays mounted, hidden below the screen: New session keeps what's typed,
/// and a ticket its tab and scroll. Only the header drags the sheet, so the content's own gestures
/// (the pager and the back swipe, the Browser tab, the transcript) keep theirs.
struct TicketSheetLayer: View {
    @Environment(Router.self) private var router
    @Environment(\.palette) private var c
    /// How far the presented sheet is dragged down by its header.
    @State private var drag: CGFloat = 0
    @State private var dragging = false
    /// How far the dock is dragged (down to send it away, up to open it).
    @State private var dockDrag: CGFloat = 0

    /// The top of the sheet that drags it: the grabber and the navigation bar.
    private static let header: CGFloat = 64
    private static let corner: CGFloat = 38

    var body: some View {
        GeometryReader { geo in
            // From the sheet's top to below the screen's bottom edge.
            let travel = geo.size.height + geo.safeAreaInsets.bottom
            let presented = router.ticketSheet != nil
            ZStack(alignment: .bottom) {
                if presented {
                    Color.black.opacity(0.25 * (1 - min(1, drag / travel)))
                        .ignoresSafeArea()
                        .transition(.opacity)
                        .accessibilityHidden(true)
                }
                if let sheet = router.ticketSheet ?? router.dock {
                    panel(sheet, travel: travel)
                        .offset(y: presented ? drag : travel + 40)
                        .allowsHitTesting(presented)
                        .accessibilityHidden(!presented)
                        .id(sheet.id)
                        .transition(.move(edge: .bottom))
                }
                if let dock = router.dock {
                    TicketDock(sheet: dock, open: restore, close: { closeDock() })
                        .offset(y: max(-24, dockDrag))
                        .opacity(1 - min(1, max(0, dockDrag) / 140))
                        .highPriorityGesture(dockGesture)
                        .padding(.horizontal, 12)
                        .padding(.bottom, TicketDock.bottomGap)
                        // At the screen's bottom, behind a keyboard rather than riding on it.
                        .ignoresSafeArea(edges: .bottom)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
        .animation(.smooth(duration: 0.35), value: router.ticketSheetState)
        .onChange(of: router.dock != nil) { _, docked in
            // A docked New session mustn't keep the keyboard up over the board.
            if docked { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }

    private func panel(_ sheet: TicketSheet, travel: CGFloat) -> some View {
        // The grabber sits over the navigation bar's top, as on a system sheet.
        stack(sheet).overlay(alignment: .top) {
            Capsule()
                .fill(c.text3.opacity(0.45))
                .frame(width: 36, height: 5)
                .padding(.top, 5)
                .accessibilityElement()
                .accessibilityLabel("Sheet grabber")
                .accessibilityHint("Double-tap to dock")
                .accessibilityAddTraits(.isButton)
                .accessibilityAction { dock() }
        }
        .clipShape(UnevenRoundedRectangle(topLeadingRadius: Self.corner, topTrailingRadius: Self.corner))
        .background {
            UnevenRoundedRectangle(topLeadingRadius: Self.corner, topTrailingRadius: Self.corner)
                .fill(c.bg)
                .shadow(color: .black.opacity(0.18), radius: 16, y: -2)
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .padding(.top, 6)
        .simultaneousGesture(sheetGesture(travel: travel))
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { dock() }
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

    // MARK: Dragging

    /// A drag that starts on the header, mostly downward. Let go near the bottom (or flicked off)
    /// the sheet goes; part way down it docks; a little way, it springs back.
    private func sheetGesture(travel: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { v in
                if !dragging {
                    guard v.startLocation.y < Self.header, v.translation.height > abs(v.translation.width) else { return }
                    dragging = true
                }
                drag = max(0, v.translation.height)
            }
            .onEnded { v in
                guard dragging else { return }
                dragging = false
                let moved = v.translation.height, flung = v.predictedEndTranslation.height
                if moved > travel - 60 || flung > travel * 1.3 {
                    withAnimation(.smooth(duration: 0.25)) { drag = travel + 40 } completion: {
                        router.dismissSheet()
                        drag = 0
                    }
                } else if moved > travel * 0.25 || flung > travel * 0.5 {
                    dock()
                } else {
                    withAnimation(.smooth(duration: 0.3)) { drag = 0 }
                }
            }
    }

    private var dockGesture: some Gesture {
        DragGesture(minimumDistance: 6)
            .onChanged { dockDrag = $0.translation.height }
            .onEnded { v in
                let moved = v.translation.height, flung = v.predictedEndTranslation.height
                if moved > 24 || flung > 90 {
                    closeDock()
                } else if moved < -24 || flung < -90 {
                    restore()
                } else {
                    withAnimation(.smooth(duration: 0.25)) { dockDrag = 0 }
                }
            }
    }

    private func dock() {
        withAnimation(.smooth(duration: 0.35)) {
            router.dockSheet()
            drag = 0
        }
    }

    private func restore() {
        withAnimation(.smooth(duration: 0.35)) {
            router.restoreDock()
            dockDrag = 0
        }
    }

    private func closeDock() {
        withAnimation(.smooth(duration: 0.2)) { dockDrag = 140 } completion: {
            router.dismissSheet()
            dockDrag = 0
        }
    }
}

/// Keeps a section's screen clear of the docked ticket sheet. It goes inside the section's
/// NavigationStack, on each screen: a safe-area inset outside the stack doesn't reach the board's
/// own bottom bar. Not while a keyboard is up: the dock is behind it.
private struct DockClearance: ViewModifier {
    @Environment(Router.self) private var router
    @Environment(\.concentricScreen) private var screen
    @State private var keyboard = false

    func body(content: Content) -> some View {
        content
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if router.dock != nil && !keyboard {
                    Color.clear.frame(height: TicketDock.clearance(homeIndicator: screen?.homeIndicator ?? 0))
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
    }
}

extension View {
    func dockClearance() -> some View { modifier(DockClearance()) }
}

/// The docked ticket sheet's bar: the ticket on top's key (or "New session"); a tap opens it again.
struct TicketDock: View {
    let sheet: TicketSheet
    let open: () -> Void
    let close: () -> Void
    @Environment(\.palette) private var c

    static let height: CGFloat = 56
    /// From the bar's bottom to the screen's edge.
    static let bottomGap: CGFloat = 14

    /// What a section gives up at its bottom while a sheet is docked, so the dock sits under the
    /// board's bottom bar rather than over it: the bar and its gap to the screen's edge, less the
    /// home indicator's inset the section already keeps clear, plus a gap above it.
    static func clearance(homeIndicator: CGFloat) -> CGFloat {
        max(0, height + bottomGap + 10 - homeIndicator)
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
            .padding(.horizontal, 20)
            .frame(maxWidth: .infinity)
            .frame(height: Self.height)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular, in: .capsule)
        .accessibilityLabel("\(sheet.title), docked")
        .accessibilityHint("Double-tap to open")
        .accessibilityIdentifier("ticket-dock")
        .accessibilityAction(named: "Close", close)
    }
}
