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
/// scroll, the nav path) but off the trailing edge, inert, while the docked cards stand in for it.
struct TicketSidePanel<Content: View>: View {
    let title: String
    var subtitle: String? = nil
    /// Whether the pop-out (own window) button shows.
    var canPopOut = true
    /// Off the edge and inert, for the docked cards.
    var docked = false
    @Binding var widthFraction: Double?
    let onDock: () -> Void
    let onPopOut: () -> Void
    let onClose: () -> Void
    /// The panel's width as it lays out (resizing included), for what sits beside it.
    var onWidth: (CGFloat) -> Void = { _ in }
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
                .onChange(of: width, initial: true) { onWidth(width) }
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

/// The ticket sheets (`Router.dockedSheets`) at regular width, over DesktopShell: TicketSidePanel
/// around the top sheet's TicketSheetContent (the iPhone sheet's content), with every live sheet
/// (`Router.liveSheets`) mounted behind it, hidden, so switching is instant and keeps each one's
/// place. The other docked tickets wait as a stack of cards in the board's bottom-right corner
/// (DockedCardStack), left of the panel while it's open and following its resize; while docked the
/// panel stays mounted off the edge and every ticket is a card. Pickers, the watcher form and
/// covers come up from the root (SceneChrome), which presents nothing else here. Pop-out hands the
/// top ticket to its own window (`Router.popOutSheet()`) where the device has windows.
struct TicketPanelHost: View {
    @Environment(AppModel.self) private var app
    @Environment(Router.self) private var router
    @Environment(\.supportsMultipleWindows) private var multipleWindows
    @Environment(DockedSheetInset.self) private var dockInset: DockedSheetInset?
    @State private var closers = TicketPanelClosers()
    @State private var panelWidth: CGFloat = 0

    var body: some View {
        let sheet = router.ticketSheet ?? router.dock
        let docked = router.ticketSheetState == .docked
        // Docked, every ticket is a card; open, the ones behind the panel's.
        let waiting = docked ? router.dockedSheets : Array(router.dockedSheets.dropFirst())
        GeometryReader { geo in
            let besidePanel = sheet != nil && !docked ? panelWidth : 0
            // The board's column only: the sidebar (left of `contentLeading`) stays clear.
            let sidebar = max(0, (dockInset?.contentLeading ?? 0) - geo.frame(in: .global).minX)
            let board = CGSize(width: max(0, geo.size.width - besidePanel - sidebar), height: geo.size.height)
            ZStack(alignment: .trailing) {
                Color.clear.allowsHitTesting(false)
                if let sheet {
                    let closer = closers.closer(sheet.id)
                    TicketSidePanel(title: sheet.title, canPopOut: multipleWindows && router.canPopOutSheet,
                                    docked: docked, widthFraction: width,
                                    onDock: { router.dockSheet() }, onPopOut: { router.popOutSheet() },
                                    onClose: { if !closer.close() { router.dismissSheet() } },
                                    onWidth: { panelWidth = $0 }) {
                        ZStack {
                            ForEach(router.liveSheets) { s in
                                let isTop = s.id == sheet.id
                                TicketSheetContent(sheet: s)
                                    .environment(\.inTicketPanel, true)
                                    .environment(closers.closer(s.id))
                                    .opacity(isTop ? 1 : 0)
                                    .allowsHitTesting(isTop)
                                    .accessibilityHidden(!isTop)
                                    .disabled(!isTop)
                                    .zIndex(isTop ? 1 : 0)
                            }
                        }
                    }
                    // Down to the window's bottom edge; the content keeps the home indicator clear.
                    .ignoresSafeArea(.container, edges: .bottom)
                    .transition(.ticketPanel)
                }
                if !waiting.isEmpty {
                    DockedCardStack(sheets: waiting, available: board)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(.trailing, besidePanel)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
            .onChange(of: DockedCardStack.height(count: waiting.count, available: board), initial: true) { _, h in
                dockInset?.cards = h > 0 ? h + DockedCardStack.margin * 2 : 0
            }
        }
        .animation(.ticketPanel, value: router.ticketSheetState)
        .animation(.ticketPanel, value: waiting.map(\.id))
        .onChange(of: router.dockedSheets.map(\.id)) { _, ids in closers.keep(Set(ids)) }
        .onChange(of: docked) { _, docked in
            // A docked New session mustn't keep the keyboard up over the board.
            if docked { resignFirstResponder() }
        }
        .onChange(of: sheet?.id) { resignFirstResponder() }
        .onDisappear { dockInset?.cards = 0 }
    }

    /// The person's width, kept in prefs; nil until they first drag the panel's edge.
    private var width: Binding<Double?> {
        Binding(get: { app.prefs.ticketPanelWidth }, set: { app.setPref(\.ticketPanelWidth, $0) })
    }
}

/// One TicketPanelCloser per ticket sheet, so a hidden New session never takes over the close
/// button of the ticket on top.
@Observable final class TicketPanelClosers {
    @ObservationIgnored private var byID: [Int: TicketPanelCloser] = [:]

    func closer(_ id: Int) -> TicketPanelCloser {
        if let closer = byID[id] { return closer }
        let closer = TicketPanelCloser()
        byID[id] = closer
        return closer
    }

    /// Forgets the closers of sheets that closed.
    func keep(_ ids: Set<Int>) { byID = byID.filter { ids.contains($0.key) } }
}

/// How the panel's close button (and Escape) closes what's on screen in it: the screen on top can
/// take it over while it's up, as New session does to ask Discard or Save like its own Cancel would.
/// Nothing registered, the button just closes the panel (`Router.dismissSheet()`).
@Observable final class TicketPanelCloser {
    private var owner: ObjectIdentifier?
    private var handler: (() -> Void)?

    /// Runs the registered handler; false when there's none, for the caller's default.
    func close() -> Bool {
        guard let handler else { return false }
        handler()
        return true
    }

    /// `owner` handles the close until it lets go (a later owner replaces it).
    func take(_ owner: AnyObject, _ handler: @escaping () -> Void) {
        self.owner = ObjectIdentifier(owner)
        self.handler = handler
    }

    /// Stops `owner` handling the close, unless another has taken it since.
    func release(_ owner: AnyObject) {
        guard self.owner == ObjectIdentifier(owner) else { return }
        self.owner = nil
        handler = nil
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
