import HarnessKit
import SwiftUI

/// The iPad's slide-over ticket (DesktopShell, at regular width): the main Router's `panel` over
/// the trailing side of the window, with its own stack, so the board stays usable beside it. Its
/// header closes it (✕, Escape, or a swipe toward the trailing edge) and detaches it into a ticket
/// window ("Open in New Window", or dragging the header out to the screen's edge).
struct TicketPanel: View {
    /// The panel's own Router (ticket scope, hosted by the main one).
    let panel: Router

    @Environment(Router.self) private var main
    @Environment(\.palette) private var c
    @Environment(\.openWindow) private var openWindow
    @Environment(\.supportsMultipleWindows) private var multipleWindows
    @State private var offset: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(c.border)
            TabStack(tab: .board) {
                if let root = panel.root { RouteScreen(route: root) }
            }
            .environment(panel)
        }
        .background(c.bg)
        .clipShape(.rect(cornerRadius: 22))
        .overlay { RoundedRectangle(cornerRadius: 22).strokeBorder(c.border, lineWidth: 1 / 3) }
        .shadow(color: .black.opacity(0.22), radius: 24, x: 0, y: 8)
        .offset(x: offset)
    }

    private var value: TicketWindowValue? { TicketWindowValue(route: panel.topTicket) }

    private var header: some View {
        HStack(spacing: 0) {
            Button("Close ticket", systemImage: "xmark") { close() }
                .labelStyle(.iconOnly)
                .keyboardShortcut(.cancelAction)
                .frame(width: 44, height: 44)
            Spacer(minLength: 0)
            Capsule().fill(c.text3.opacity(0.5)).frame(width: 40, height: 5).accessibilityHidden(true)
            Spacer(minLength: 0)
            if multipleWindows {
                Button("Open in New Window", systemImage: "macwindow.badge.plus") { detach() }
                    .labelStyle(.iconOnly)
                    .frame(width: 44, height: 44)
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
        }
        .font(.scaled(size: 15, weight: .semibold))
        .foregroundStyle(c.text2)
        .padding(.horizontal, 4)
        .frame(height: 44)
        .contentShape(.rect)
        // A swipe toward the trailing edge closes it.
        .gesture(
            DragGesture(minimumDistance: 14)
                .onChanged { g in offset = max(0, g.translation.width) }
                .onEnded { g in
                    if g.translation.width > 120 || g.predictedEndTranslation.width > 260 {
                        close()
                    } else {
                        withAnimation(.snappy) { offset = 0 }
                    }
                }
        )
        // Held and dragged out to the screen's edge, it becomes a window of its own.
        .onDrag {
            guard multipleWindows, let value else { return NSItemProvider() }
            return ticketWindowItemProvider(value, title: value.key)
        }
    }

    private func close() {
        withAnimation(.snappy) { main.closePanel() }
    }

    private func detach() {
        guard let route = main.detachPanel(), let v = TicketWindowValue(route: route) else { return }
        openWindow(id: SceneID.ticket, value: v)
    }
}

/// DesktopShell's overlay: the open panel on the trailing side, sliding in and out.
struct TicketPanelOverlay: View {
    @Environment(Router.self) private var router

    var body: some View {
        GeometryReader { geo in
            let width = min(max(geo.size.width * 0.5, 400), 520, geo.size.width - 24)
            ZStack(alignment: .trailing) {
                // The board behind stays tappable.
                Color.clear.allowsHitTesting(false)
                if let panel = router.panel {
                    TicketPanel(panel: panel)
                        .id(ObjectIdentifier(panel))
                        .frame(width: width)
                        .padding(.vertical, 8)
                        .padding(.trailing, 10)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .animation(.snappy, value: router.panel.map(ObjectIdentifier.init))
        }
    }
}
