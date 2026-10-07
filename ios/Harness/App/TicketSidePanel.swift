import HarnessKit
import SwiftUI

/// The iPad's ticket panel (regular width): a full-height panel against the window's trailing
/// edge, with the board to its left still live (no dimming). Place it over the board so it fills
/// the window; it lays itself out trailing-aligned at `TicketPanelWidth` of the window's width and
/// leaves the rest of the area untouched, so taps there reach the board. TicketPanelHost is the
/// app's host.
///
/// `widthFraction` is nil until the person drags the edge (until then 800pt, clamped, is used);
/// the app binds it to the `ticketPanelWidth` pref to keep it across launches. Dragging the leading
/// handle resizes it; flinging the title bar right docks it (it slides off the edge first, then
/// `onDock` runs); Escape on a hardware keyboard closes it. `docked` keeps it mounted (drafts,
/// scroll, the nav path) but off the trailing edge, inert, while the dock pill stands in for it.
struct TicketSidePanel<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    /// Whether the pop-out (own window) button shows.
    var canPopOut = true
    /// Off the edge and inert, for the dock pill.
    var docked = false
    @Binding var widthFraction: Double?
    let onDock: () -> Void
    let onPopOut: () -> Void
    let onClose: () -> Void
    @ViewBuilder let content: () -> Content

    @Environment(\.palette) private var c
    /// The width while the handle is being dragged, in points; nil otherwise.
    @State private var dragWidth: CGFloat?
    /// The width when the current resize began.
    @State private var resizeStart: CGFloat?
    /// How far the title bar fling has pushed the panel toward the trailing edge.
    @State private var flingOffset: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let window = geo.size.width
            let width = dragWidth ?? TicketPanelWidth.width(windowWidth: window, stored: widthFraction)
            panel(width: width, window: window)
                .frame(width: width)
                .offset(x: docked ? width + Self.shadowReach : flingOffset)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
        }
        // Docked, nothing in it answers a tap, a key command (Escape included) or VoiceOver.
        .disabled(docked)
        .allowsHitTesting(!docked)
        .accessibilityHidden(docked)
        .onAppear { flingOffset = 0 }
        // A fling has already carried it off the edge; restored, it comes back from its place.
        .onChange(of: docked) { flingOffset = 0 }
    }

    private func panel(width: CGFloat, window: CGFloat) -> some View {
        VStack(spacing: 0) {
            titleBar(width: width)
            Rectangle().fill(c.border).frame(height: 1)
            content()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(c.bg)
        .clipShape(Self.shape)
        .shadow(color: .black.opacity(c.isDark ? 0.45 : 0.16), radius: 18, x: -4)
        .overlay(alignment: .leading) { resizeHandle(width: width, window: window) }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ticket-panel")
    }

    // MARK: Title bar

    private func titleBar(width: CGFloat) -> some View {
        HStack(spacing: 4) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(c.text)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(c.text3)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 8)
            barButton("pip.enter", label: "Dock \(title)", id: "ticket-panel-dock", action: onDock)
            if canPopOut {
                barButton("macwindow.badge.plus", label: "Open \(title) in a new window", id: "ticket-panel-popout", action: onPopOut)
            }
            barButton("xmark", label: "Close \(title)", id: "ticket-panel-close", action: onClose)
                // Escape on a hardware keyboard closes the panel, focused or not.
                .keyboardShortcut(docked ? nil : .cancelAction)
        }
        .padding(.leading, 20)
        .padding(.trailing, 8)
        .frame(height: Self.titleBarHeight)
        .contentShape(.rect)
        // The fling lives on the title bar alone, so it never fights horizontal scrolling in the
        // ticket's content.
        .gesture(fling(width: width))
    }

    private func barButton(_ symbol: String, label: String, id: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.body.weight(.medium))
                .foregroundStyle(c.text2)
                .frame(width: 40, height: 40)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }

    /// A rightward drag moves the panel with the finger; past `flingDistance` (or a throw whose
    /// predicted end gets there) it carries on off the edge and docks, otherwise it springs back.
    private func fling(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 12, coordinateSpace: .global)
            .onChanged { value in
                // Only toward the edge: the panel doesn't drag out past its resting place.
                flingOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                let docks = Self.shouldDock(translation: value.translation.width, predicted: value.predictedEndTranslation.width, width: width)
                if docks {
                    withAnimation(.snappy(duration: 0.25)) {
                        flingOffset = width + Self.shadowReach
                    } completion: {
                        onDock()
                    }
                } else {
                    withAnimation(.spring(duration: 0.3, bounce: 0.2)) { flingOffset = 0 }
                }
            }
    }

    /// Whether a title bar drag that ended at `translation` (with the system's predicted end)
    /// docks a panel `width` wide: a third of the panel or 160pt dragged, whichever is less, or a
    /// throw predicted to carry half the panel.
    static func shouldDock(translation: CGFloat, predicted: CGFloat, width: CGFloat) -> Bool {
        translation >= min(160, width / 3) || predicted >= width / 2
    }

    // MARK: Resize

    private func resizeHandle(width: CGFloat, window: CGFloat) -> some View {
        Capsule()
            .fill(c.borderStrong)
            .frame(width: 5, height: 44)
            .frame(width: Self.handleWidth)
            .frame(maxHeight: .infinity)
            .contentShape(.rect)
            .offset(x: -Self.handleWidth / 2)
            // iPadOS has no resize cursor for SwiftUI (`pointerStyle` is macOS/visionOS only): the
            // pointer morphs into the handle instead, the iPad's cue for something to grab.
            .hoverEffect(.highlight)
            .gesture(
                // Global, since the panel's own frame moves as it resizes.
                DragGesture(minimumDistance: 0, coordinateSpace: .global)
                    .onChanged { value in
                        let start = resizeStart ?? width
                        if resizeStart == nil { resizeStart = width }
                        dragWidth = TicketPanelWidth.clampedWidth(start - value.translation.width, windowWidth: window)
                    }
                    .onEnded { value in
                        let start = resizeStart ?? width
                        widthFraction = TicketPanelWidth.fraction(forWidth: start - value.translation.width, windowWidth: window)
                        dragWidth = nil
                        resizeStart = nil
                    }
            )
            .accessibilityLabel("Resize panel")
            .accessibilityValue("\(Int((TicketPanelWidth.fraction(forWidth: width, windowWidth: window) * 100).rounded())) percent of the window")
            .accessibilityAdjustableAction { direction in
                let now = TicketPanelWidth.fraction(forWidth: width, windowWidth: window)
                widthFraction = TicketPanelWidth.clamp(now + (direction == .increment ? 0.05 : -0.05))
            }
            .accessibilityIdentifier("ticket-panel-resize")
    }

    private static var shape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, style: .continuous)
    }

    private static var titleBarHeight: CGFloat { 52 }
    /// The handle's touch target, centred on the panel's leading edge.
    private static var handleWidth: CGFloat { 24 }
    /// Extra travel past the edge so the shadow leaves the screen with the panel.
    private static var shadowReach: CGFloat { 40 }
}

extension AnyTransition {
    /// How the host inserts and removes `TicketSidePanel`: in from the trailing edge.
    static var ticketPanel: AnyTransition { .move(edge: .trailing) }
}

extension Animation {
    /// The panel's slide in and out.
    static var ticketPanel: Animation { .snappy }
}

/// The docked panel, stashed at the window's trailing edge like Picture in Picture: a floating
/// capsule vertically centred on the edge with about a third of it off screen, a chevron pointing
/// back in and the ticket's key. Place it as `.overlay(alignment: .trailing)` over the board; it
/// offsets itself past the edge. Tap it or drag it left to restore the panel; Close is in its
/// context menu and its accessibility actions.
struct TicketDockPill: View {
    /// The ticket's key, or "New session" (`TicketSheet.title`).
    let label: String
    let onRestore: () -> Void
    let onClose: () -> Void

    @Environment(\.palette) private var c
    /// How far it's been dragged back in (negative, leftward).
    @State private var dragX: CGFloat = 0

    var body: some View {
        Button(action: onRestore) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(c.accent)
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(c.text)
                    .lineLimit(1)
            }
            .padding(.leading, 16)
            // The hidden part past the edge, so the label sits in what's on screen.
            .padding(.trailing, 12 + Self.offscreen)
            .frame(height: Self.height)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .shadow(color: .black.opacity(0.18), radius: 10, x: -2, y: 2)
        .contentShape(.contextMenuPreview, .capsule)
        .contextMenu {
            Button("Close", systemImage: "xmark", role: .destructive, action: onClose)
        }
        .offset(x: Self.offscreen + dragX)
        .simultaneousGesture(
            DragGesture(minimumDistance: 10)
                .onChanged { value in dragX = min(0, value.translation.width) }
                .onEnded { value in
                    if Self.restores(translation: value.translation.width, predicted: value.predictedEndTranslation.width) {
                        onRestore()
                    }
                    withAnimation(.snappy) { dragX = 0 }
                }
        )
        .accessibilityLabel("\(label), docked")
        .accessibilityHint("Double-tap to open")
        .accessibilityIdentifier("ticket-dock")
        .accessibilityAction(named: "Close", onClose)
    }

    /// Whether a leftward drag that ended at `translation` pulls the panel back out.
    static func restores(translation: CGFloat, predicted: CGFloat) -> Bool {
        translation <= -40 || predicted <= -120
    }

    static let height: CGFloat = 52
    /// How much of the capsule sits past the window's edge: about a third of a short label's pill.
    static let offscreen: CGFloat = 28
}

/// The ticket sheet (`Router.ticketSheet` / `Router.dock`) at regular width, over DesktopShell:
/// TicketSidePanel around TicketSheetContent (the iPhone sheet's content), and while docked the
/// panel stays mounted off the edge with TicketDockPill standing in for it. Pickers, the watcher
/// form and covers come up from the root (SceneChrome), which presents nothing else here. Pop-out
/// hands the ticket to its own window (`Router.popOutSheet()`) where the device has windows.
struct TicketPanelHost: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.supportsMultipleWindows) private var multipleWindows

    var body: some View {
        let sheet = router.ticketSheet ?? router.dock
        let docked = router.ticketSheetState == .docked
        ZStack(alignment: .trailing) {
            Color.clear.allowsHitTesting(false)
            if let sheet {
                TicketSidePanel(title: sheet.title, canPopOut: multipleWindows && router.canPopOutSheet,
                                docked: docked, widthFraction: width,
                                onDock: { router.dockSheet() }, onPopOut: { router.popOutSheet() },
                                onClose: { router.dismissSheet() }) {
                    TicketSheetContent(sheet: sheet)
                }
                // Down to the window's bottom edge; the content keeps the home indicator clear.
                .ignoresSafeArea(.container, edges: .bottom)
                .transition(.ticketPanel)
            }
            if let dock = router.dock {
                TicketDockPill(label: dock.title, onRestore: { router.restoreDock() }, onClose: { router.dismissSheet() })
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .animation(.ticketPanel, value: router.ticketSheetState)
        .onChange(of: docked) { _, docked in
            // A docked New session mustn't keep the keyboard up over the board.
            if docked { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }

    /// The person's width, kept in prefs; nil until they first drag the panel's edge.
    private var width: Binding<Double?> {
        Binding(get: { app.prefs.ticketPanelWidth }, set: { app.setPref(\.ticketPanelWidth, $0) })
    }
}

#Preview("Side panel") {
    @Previewable @State var fraction: Double? = nil
    ZStack {
        Color.gray.opacity(0.2).ignoresSafeArea()
        TicketSidePanel(title: "HARNESS-365", subtitle: "iPad side panel", widthFraction: $fraction,
                        onDock: {}, onPopOut: {}, onClose: {}) {
            List(0..<30) { Text("Row \($0)") }
        }
    }
}

#Preview("Dock pill") {
    ZStack {
        Color.gray.opacity(0.2).ignoresSafeArea()
        TicketDockPill(label: "HARNESS-365", onRestore: {}, onClose: {})
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    }
}
