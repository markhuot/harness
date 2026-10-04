import HarnessKit
import SwiftUI

// Pieces the ticket screen shares with its tab bodies:
// the hero's collapse state, the scroll trackers a tab body attaches, the tab opener the Agents and
// Transcript slots use to open a sub-agent, and a wrapping row layout.

/// The ticket hero's collapse: HeroCollapse's rules fed by the tab body's
/// scroll gestures. `show()` brings it back (another tab, news on the ticket); `measured` takes the
/// hero's height while it's shown, which is how much room hiding it gives the tab body.
@MainActor
@Observable
final class TicketDetailHeroCollapse {
    private(set) var hidden = false
    @ObservationIgnored private var state = HeroCollapse.shown
    @ObservationIgnored private var heroHeight: Double = 0

    func send(_ e: CollapseEvent) {
        let next = HeroCollapse.step(state, e, heroHeight: heroHeight)
        state = next
        guard next.hidden != hidden else { return }
        withAnimation(.easeInOut(duration: 0.22)) { hidden = next.hidden }
    }

    func show() { send(.show) }

    func measured(_ height: Double) {
        if !state.hidden { heroHeight = height }
    }
}

extension BoardStore {
    /// `api`, or the "No connection" error a user action should surface (Actions.run/perform toast
    /// it) instead of silently doing nothing when the store has no HarnessClient.
    func connectedAPI() throws -> HarnessClient {
        guard let api else { throw HarnessAPIError(status: 0, message: "No connection", data: nil) }
        return api
    }
}

/// Opens a tab on the ticket screen that hosts the view (a sub-agent's `agent:<id>`, or back to
/// `agents`). Nil outside a ticket screen.
struct TicketDetailTabOpener: Sendable {
    let open: @MainActor @Sendable (TicketTab) -> Void

    @MainActor func callAsFunction(_ tab: TicketTab) { open(tab) }
}

extension EnvironmentValues {
    /// The hero collapse of the ticket screen around a tab body; nil elsewhere.
    @Entry var ticketDetailHero: TicketDetailHeroCollapse?
    /// `openTab(Tabs.subagentTabRoute(id))` from inside a ticket tab body.
    @Entry var ticketDetailOpenTab: TicketDetailTabOpener?
    /// Where an image annotated inside a ticket goes: its composer's attachments (AnnotatorView).
    /// nil outside a ticket, where nothing offers Annotate unless it says where the image goes.
    @Entry var annotationSink: AnnotationSink?
    /// Opens the annotator over the ticket (TicketDetailBody presents it).
    @Entry var openAnnotator: AnnotatorOpener?
}

/// Takes an annotated image into the ticket's composer.
struct AnnotationSink: Sendable {
    let add: @MainActor @Sendable (AnnotatedImage) -> Void

    /// Annotate `image` from `source`, the result going to the composer.
    @MainActor func request(_ source: AnnotationSource, image: UIImage) -> AnnotationRequest {
        AnnotationRequest(source: source, image: image, add: add)
    }
}

struct AnnotatorOpener: Sendable {
    let open: @MainActor @Sendable (AnnotationRequest) -> Void

    @MainActor func callAsFunction(_ request: AnnotationRequest) { open(request) }
}

extension View {
    /// On a tab body's ScrollView or List: its drags and flings hide and bring back the ticket hero.
    /// Does nothing outside a ticket screen.
    func ticketHeroScroll() -> some View { modifier(TicketDetailHeroScroll()) }

    /// On a ScrollView whose newest content is last: opens at the bottom,
    /// follows new content while the user is at the bottom, stays put once they scroll up, and
    /// follows again when they come back down.
    func ticketStickToBottom() -> some View { modifier(TicketDetailStickToBottom()) }
}

private func scrollMetrics(_ g: ScrollGeometry) -> ScrollMetrics {
    ScrollMetrics(contentOffsetY: g.contentOffset.y, contentHeight: g.contentSize.height, containerHeight: g.containerSize.height,
                  topInset: g.contentInsets.top, bottomInset: g.contentInsets.bottom)
}

private func scrollPhase(_ p: ScrollPhase) -> StickScrollPhase {
    switch p {
    case .idle: .idle
    case .tracking: .tracking
    case .interacting: .interacting
    case .decelerating: .decelerating
    case .animating: .animating
    @unknown default: .idle
    }
}

private struct TicketDetailHeroScroll: ViewModifier {
    @Environment(\.ticketDetailHero) private var hero
    @State private var metrics = ScrollMetrics(offset: 0, contentHeight: 0, viewportHeight: 0)

    func body(content: Content) -> some View {
        content
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { _, m in
                metrics = m
                hero?.send(.scroll(m))
            }
            .onScrollPhaseChange { old, new in
                for e in HeroCollapse.events(from: scrollPhase(old), to: scrollPhase(new), metrics: metrics) { hero?.send(e) }
            }
    }
}

private struct TicketDetailStickToBottom: ViewModifier {
    @State private var stick = StickToBottom.stuck
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var metrics = ScrollMetrics(offset: 0, contentHeight: 0, viewportHeight: 0)

    func body(content: Content) -> some View {
        content
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom, for: .initialOffset)
            .onScrollGeometryChange(for: ScrollMetrics.self, of: scrollMetrics) { old, m in
                metrics = m
                apply(.scroll(m))
                // Content grew or shrank, or the viewport changed (the hero, the keyboard).
                if old.contentHeight != m.contentHeight || old.viewportHeight != m.viewportHeight { apply(.resize) }
            }
            .onScrollPhaseChange { old, new in
                for e in StickToBottom.events(from: scrollPhase(old), to: scrollPhase(new), metrics: metrics) { apply(e) }
            }
    }

    private func apply(_ e: StickEvent) {
        let step = StickToBottom.stickStep(stick, e)
        stick = step.stick
        if step.follow { position.scrollTo(edge: .bottom) }
    }
}

